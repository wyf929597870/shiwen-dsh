"""Compare isolated Node ONNX vectors to the original PyTorch model on the fixed corpus."""
import json, sys
from pathlib import Path
import numpy as np
import torch
from transformers import AutoTokenizer, AutoModel
if len(sys.argv) != 4:
    raise SystemExit('Usage: python scripts/verify-pc-semantic-model.py ORIGINAL_MODEL_DIR FIXTURE_DIR NODE_VECTORS_JSON')
model_dir, fixture_dir, node_file = map(Path, sys.argv[1:])
fixture = json.loads((fixture_dir / 'fixture.json').read_text())
chunks = json.loads((fixture_dir / 'chunks.json').read_text())
texts = [c['text'] for c in chunks] + ['为这个句子生成表示以用于检索相关文章：' + q['text'] for q in fixture['queries']]
tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
model = AutoModel.from_pretrained(model_dir, local_files_only=True).eval()
reference = []
with torch.no_grad():
    for i in range(0, len(texts), 16):
        batch = tokenizer(texts[i:i+16], padding=True, truncation=True, max_length=512, return_tensors='pt')
        vectors = model(**batch).last_hidden_state[:, 0]
        reference.extend(torch.nn.functional.normalize(vectors, p=2, dim=1).numpy())
reference = np.asarray(reference)
actual = np.asarray(json.loads(node_file.read_text()))
if reference.shape != actual.shape:
    raise SystemExit('Vector shape mismatch')
cosine = (reference * actual).sum(axis=1)
n = len(chunks)
a, b = reference[n:] @ reference[:n].T, actual[n:] @ actual[:n].T
matched = [len(set(np.argsort(-x)[:5]) & set(np.argsort(-y)[:5])) for x, y in zip(a, b)]
print(json.dumps({'vectors': len(cosine), 'minimum_cosine': float(cosine.min()), 'max_abs_difference': float(np.max(np.abs(reference-actual))), 'top5_overlap': matched}, ensure_ascii=False))
if cosine.min() < .9999 or any(x < 5 for x in matched):
    raise SystemExit('Model comparison failed')
