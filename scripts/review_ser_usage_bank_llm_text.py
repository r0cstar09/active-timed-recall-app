#!/usr/bin/env python3
from __future__ import annotations
import json, os, time
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parents[1]
BANK=ROOT/'src/data/generated/c1_verb_usage_banks.json'
OUT=ROOT/'reports/ser_usage_llm_generation/llm_quality_review_text.md'
URL=os.getenv('SPANISH_LLM_PROXY','http://34.24.121.154:8787/v1/chat/completions')
MODEL=os.getenv('SPANISH_LLM_MODEL','gemini-2.5-flash')

def call(msg):
    payload={'model':MODEL,'messages':[{'role':'system','content':'You are a concise Spanish C1 curriculum QA reviewer. Flag only clear fix-before-study problems.'},{'role':'user','content':msg}], 'temperature':0.1, 'max_tokens':2500}
    last=None
    for i in range(4):
        try:
            r=requests.post(URL,json=payload,timeout=140)
            if r.status_code==200: return r.json()['choices'][0]['message']['content']
            last=r.text[:300]
        except Exception as e: last=repr(e)
        time.sleep(2+i)
    raise RuntimeError(last)

prompts=json.load(open(BANK,encoding='utf-8'))['verbs']['ser']['prompts']
parts=[f'# SER usage bank LLM QA review\n\nmodel: {MODEL}\n']
fix_lines=[]
for b in range(1,11):
    compact=[]
    for p in prompts:
        if p['batch']==b:
            compact.append(f"{p['id']} | {p['tense']} | {p['construction']} | EN: {p['prompt_en']} | ES: {p['expected_es']} | vocab: {', '.join(p['target_vocabulary'])}")
    msg='''Review these 50 SER prompts. Flag only clear fix-before-study issues: wrong/unnatural Spanish, English mismatch, wrong SER use, obvious estar/tener/haber issue, bizarre semantics, target vocabulary misuse, or prompt leaks Spanish.

Respond in this exact plain-text style:
FIXES: NONE
OVERALL: one sentence

If there are fixes, use:
FIXES:
- ser-usage-123: issue; suggested Spanish: ...
OVERALL: one sentence

Prompts:\n'''+"\n".join(compact)
    print('review batch',b,flush=True)
    text=call(msg).strip()
    parts.append(f'\n## Batch {b}\n\n{text}\n')
    for line in text.splitlines():
        if line.strip().startswith('- ser-usage-'):
            fix_lines.append(line.strip())
OUT.write_text('\n'.join(parts),encoding='utf-8')
print('fix_lines',len(fix_lines))
for x in fix_lines[:30]: print(x)
