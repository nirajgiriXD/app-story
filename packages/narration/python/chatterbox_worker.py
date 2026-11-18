"""Speaks narration lines with Chatterbox (Resemble AI, MIT licence) for AppStory.

AppStory starts this once and keeps it running, so each model loads only once. It writes
one JSON line when it is ready, then reads one JSON request per line on stdin:

    {"text": "...", "out": "clip.wav", "voice": "my-voice.wav" or null, "exaggeration": 0.5,
     "language": "de" or null}

and answers each with one JSON line: {"ok": true} or {"error": "..."}.
English lines use Chatterbox; a line with a language uses Chatterbox Multilingual
(23 languages), loaded the first time one is asked for.
Install: pip install chatterbox-tts
"""

import json
import sys


def main() -> None:
    try:
        import torch
        import torchaudio
        from chatterbox.tts import ChatterboxTTS
    except ImportError as error:
        print(json.dumps({"error": f"Chatterbox is not installed ({error}). Run: pip install chatterbox-tts"}), flush=True)
        return

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    models = {}

    def english():
        if "en" not in models:
            models["en"] = ChatterboxTTS.from_pretrained(device=device)
        return models["en"]

    def multilingual():
        if "mtl" not in models:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            models["mtl"] = ChatterboxMultilingualTTS.from_pretrained(device=device)
        return models["mtl"]

    # A product in English only never loads the multilingual model, and the other way round.
    print(json.dumps({"ready": True, "device": device}), flush=True)

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            language = request.get("language") or None
            options = {
                "audio_prompt_path": request.get("voice") or None,
                "exaggeration": float(request.get("exaggeration", 0.5)),
                "cfg_weight": float(request.get("cfg_weight", 0.5)),
            }
            if language:
                model = multilingual()
                wav = model.generate(request["text"], language_id=language, **options)
            else:
                model = english()
                wav = model.generate(request["text"], **options)
            torchaudio.save(request["out"], wav, model.sr)
            print(json.dumps({"ok": True}), flush=True)
        except Exception as error:  # one bad line must not stop the voice
            print(json.dumps({"error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
