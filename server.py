import os
import time
import ctranslate2
from transformers import AutoTokenizer
import re
import shutil
from flask import Flask, request, jsonify
from flask_cors import CORS
import threading
from concurrent.futures import ThreadPoolExecutor

# Configuración del modelo
MODEL_NAME = "Helsinki-NLP/opus-mt-zh-en"
MODEL_PATH = "ctranslate2_zh-en"
TOKENIZER_PATH = "tokenizer_zh-en"

# Inicializar Flask
app = Flask(__name__)
CORS(app)

# Configuración del ejecutor asíncrono
MAX_WORKERS = 4  # Número máximo de traducciones concurrentes
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

# Almacenamiento local por hilo para traductores
thread_local = threading.local()

# Tokenizador global (seguro para hilos)
tokenizer = None

def download_and_convert_model():
    """Descarga y convierte el modelo a formato CTranslate2"""
    from transformers import AutoModelForSeq2SeqLM
    
    print(f"Descargando {MODEL_NAME}...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME)
    
    # Directorio temporal
    temp_dir = "temp_model"
    os.makedirs(temp_dir, exist_ok=True)
    model.save_pretrained(temp_dir)
    tokenizer.save_pretrained(temp_dir)
    
    print(f"Convirtiendo modelo a formato optimizado...")
    converter = ctranslate2.converters.TransformersConverter(
        model_name_or_path=temp_dir,
        low_cpu_mem_usage=True,
    )
    converter.convert(
        output_dir=MODEL_PATH,
        quantization="int8",
        force=True
    )
    
    # Guardar tokenizer
    tokenizer.save_pretrained(TOKENIZER_PATH)
    
    # Limpiar temporal
    shutil.rmtree(temp_dir)
    print("¡Modelo convertido y listo para usar!")
    return tokenizer

def load_tokenizer():
    """Carga el tokenizador"""
    if not os.path.exists(MODEL_PATH):
        tokenizer = download_and_convert_model()
    else:
        tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_PATH)
    return tokenizer

def get_thread_local_translator():
    """Obtiene el traductor para el hilo actual, creándolo si es necesario"""
    if not hasattr(thread_local, 'translator'):
        thread_local.translator = ctranslate2.Translator(
            MODEL_PATH,
            device="cpu",
            compute_type="int8",
            intra_threads=1  # Hilos por traducción
        )
    return thread_local.translator

def split_chinese_sentences(text):
    """Divide texto chino en oraciones"""
    delimiters = r'(?<=[。！？；])'
    sentences = re.split(delimiters, text)
    return [s.strip() for s in sentences if s.strip()]

def translate_text(text):
    """Traduce texto chino a inglés usando el modelo cargado"""
    if not text.strip():
        return ""
    
    sentences = split_chinese_sentences(text)
    if not sentences:
        return ""
    
    # Tokenización (usa el tokenizador global)
    global tokenizer
    inputs = tokenizer(
        sentences,
        padding=True,
        truncation=True,
        return_tensors="pt",
        max_length=512
    )
    
    # Convertir a tokens
    input_tokens = [
        tokenizer.convert_ids_to_tokens(ids)
        for ids in inputs["input_ids"]
    ]
    
    # Obtener traductor local al hilo
    translator = get_thread_local_translator()
    
    # Traducción por lotes
    results = translator.translate_batch(
        input_tokens,
        beam_size=1,
        max_batch_size=2048
    )
    
    # Decodificar resultados
    return " ".join(
        tokenizer.decode(
            tokenizer.convert_tokens_to_ids(result.hypotheses[0]),
            skip_special_tokens=True
        ) for result in results
    )

# Cargar tokenizador al iniciar la aplicación
print("Cargando tokenizador...")
start_time = time.time()
tokenizer = load_tokenizer()
print(f"Tokenizador cargado en {time.time() - start_time:.2f} segundos")

@app.route('/translate', methods=['GET', 'POST', 'OPTIONS'])
def translate_endpoint():
    """Endpoint para traducir texto"""
    if request.method == 'GET':
        return '''
        <form method="POST">
            <textarea name="text" rows="10" cols="50" placeholder="Escribe texto en chino aquí"></textarea><br>
            <input type="submit" value="Traducir">
        </form>
        '''
    
    if request.method == 'POST':
        if request.is_json:
            data = request.get_json()
            text = data.get('text', '')
        else:
            text = request.form.get('text', '')
        
        if not text:
            return jsonify({"error": "No se proporcionó texto"}), 400
        
        try:
            start_time = time.time()
            # Ejecutar traducción en un hilo del pool
            future = executor.submit(translate_text, text)
            translated_text = future.result()  # Espera el resultado
            translation_time = time.time() - start_time
            
            return jsonify({
                "original_text": text,
                "translated_text": translated_text,
                "translation_time": f"{translation_time:.3f} segundos",
                "characters": len(text)
            })
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    
    return jsonify({}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)