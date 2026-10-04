import importlib.util
import shutil
import subprocess
import sys

def check_whisper():
    spec = importlib.util.find_spec('whisper')
    print('whisper_installed' if spec else 'whisper_missing')

def check_ffmpeg():
    ff = shutil.which('ffmpeg')
    if ff:
        try:
            out = subprocess.run([ff, '-version'], capture_output=True, text=True, timeout=5)
            print('ffmpeg_ok')
        except Exception as e:
            print('ffmpeg_error', e)
    else:
        print('ffmpeg_missing')

def check_piper():
    # check for common piper package names
    for name in ('piper', 'piper_tts', 'piper-tts'):
        spec = importlib.util.find_spec(name)
        if spec:
            print('piper_installed', name)
            return
    print('piper_missing')

if __name__ == '__main__':
    check_whisper()
    check_ffmpeg()
    check_piper()
