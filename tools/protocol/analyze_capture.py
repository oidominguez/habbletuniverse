"""
Análise offline de uma captura NDJSON: headers por direção, strings por header,
e linha do tempo ao redor de cada marcador.

uso: python analyze_capture.py [caminho.ndjson] [--around SEGUNDOS] [--header N] [--hex]
"""
import base64, json, os, sys, time, io
from collections import defaultdict
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

def load(path):
    """Aceita NDJSON gravado pelo app ou o JSON exportado pela aba Protocolo."""
    out = []
    with open(path, encoding='utf-8') as f:
        text = f.read()
    if text.lstrip().startswith('{'):
        data = json.loads(text)
        for e in data.get('entries', []):
            k = e.get('kind')
            if k == 'packet': out.append({'kind': 'packet', **e['packet']})
            elif k == 'socket': out.append({'kind': 'socket', **e['event']})
            elif k == 'marker': out.append({'kind': 'marker', 't': e['t'], 'text': e['text']})
        if data.get('probe'): out.append({'kind': 'probe', **data['probe']})
        return out
    for line in text.splitlines():
        try: out.append(json.loads(line))
        except Exception: pass
    return out

def strings_of(b64, limit=8):
    try: u8 = base64.b64decode(b64)
    except Exception: return []
    out, i, n = [], 0, len(u8)
    while i + 2 <= n and len(out) < limit:
        ln = int.from_bytes(u8[i:i+2], 'big', signed=True)
        if 1 <= ln <= 400 and i + 2 + ln <= n:
            try:
                s = u8[i+2:i+2+ln].decode('utf-8')
                if s.isprintable() and s.strip():
                    out.append((i, s)); i += 2 + ln; continue
            except Exception: pass
        i += 1
    return out

def hexdump(b64, width=16, maxlines=12):
    u8 = base64.b64decode(b64)
    lines = []
    for off in range(0, min(len(u8), width*maxlines), width):
        chunk = u8[off:off+width]
        hx = ' '.join(f'{b:02x}' for b in chunk).ljust(width*3)
        asc = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        lines.append(f'  {off:04x}  {hx} |{asc}|')
    if len(u8) > width*maxlines: lines.append(f'  ... ({len(u8)} bytes)')
    return '\n'.join(lines)

def ints_of(b64, maxn=6):
    u8 = base64.b64decode(b64)
    vals = []
    for i in range(0, min(len(u8)-3, 4*maxn), 4):
        vals.append(int.from_bytes(u8[i:i+4], 'big', signed=True))
    return vals

def t(ms): return time.strftime('%H:%M:%S', time.localtime(ms/1000)) + f'.{ms%1000:03d}'

def main():
    args = sys.argv[1:]
    latest = os.path.join(os.environ['APPDATA'], 'habblet-addall', 'captures', 'latest.txt')
    path = next((a for a in args if a.endswith('.ndjson') or a.endswith('.json')), None) or open(latest).read().strip()
    around = float(args[args.index('--around')+1]) if '--around' in args else 3.0
    only_header = int(args[args.index('--header')+1]) if '--header' in args else None
    show_hex = '--hex' in args
    ev = load(path)
    pk = [e for e in ev if e.get('kind') == 'packet']
    print(f'arquivo: {path}\neventos: {len(ev)}  pacotes: {len(pk)}')

    if only_header is not None:
        sel = [p for p in pk if p['header'] == only_header]
        print(f'\n== header {only_header}: {len(sel)} pacotes ==')
        for p in sel[:60]:
            print(f"[{t(p['t'])}] {'↑' if p['dir']=='out' else '↓'} {p['bodyLength']}B ints={ints_of(p['body'])} strs={[s for _,s in strings_of(p['body'])]}")
            if show_hex: print(hexdump(p['body']))
        return

    # resumo por header
    stats = defaultdict(lambda: {'n':0,'bytes':0,'strs':defaultdict(int),'sizes':set()})
    for p in pk:
        st = stats[(p['dir'], p['header'])]
        st['n'] += 1; st['bytes'] += p['bodyLength']; st['sizes'].add(p['bodyLength'])
        if p['bodyLength'] <= 4096:
            for _, s in strings_of(p['body'], 4): st['strs'][s] += 1
    for d in ('out', 'in'):
        print(f"\n== {'↑ SAÍDA' if d=='out' else '↓ ENTRADA'} ==")
        rows = sorted([(k, v) for k, v in stats.items() if k[0] == d], key=lambda kv: -kv[1]['n'])
        for (_, h), st in rows:
            sizes = sorted(st['sizes']); sz = f"{sizes[0]}" if len(sizes) == 1 else f"{sizes[0]}..{sizes[-1]}"
            top = ', '.join(f"{repr(s)[1:-1][:30]}×{c}" for s, c in sorted(st['strs'].items(), key=lambda kv: -kv[1])[:5])
            print(f"  {h:>6} ×{st['n']:<5} corpo {sz:>9} B  {top}")

    # linha do tempo ao redor de marcadores
    marks = [e for e in ev if e.get('kind') == 'marker']
    for m in marks:
        print(f"\n▶ [{t(m['t'])}] MARCADOR: {m.get('text')}")
        lo, hi = m['t'] - 800, m['t'] + around*1000
        for p in pk:
            if lo <= p['t'] <= hi:
                rel = (p['t'] - m['t'])/1000
                print(f"   {rel:+6.2f}s {'↑' if p['dir']=='out' else '↓'} {p['header']:>6} {p['bodyLength']:>5}B ints={ints_of(p['body'],4)} strs={[s for _,s in strings_of(p['body'],4)]}")

if __name__ == '__main__':
    main()
