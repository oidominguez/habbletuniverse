"""
Segue (tail -F) o NDJSON da captura de protocolo e imprime um resumo compacto por janela
de tempo, mais marcadores/socket/sondagem imediatamente. Cada linha impressa vira um evento.
"""
import base64, json, os, sys, time, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

LATEST = os.path.join(os.environ['APPDATA'], 'habblet-addall', 'captures', 'latest.txt')
WINDOW = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
labels = {}

def strings_of(b64, limit=3):
    try:
        u8 = base64.b64decode(b64)
    except Exception:
        return []
    out, i, n = [], 0, len(u8)
    while i + 2 <= n and len(out) < limit:
        ln = int.from_bytes(u8[i:i+2], 'big', signed=True)
        if 1 <= ln <= 300 and i + 2 + ln <= n:
            try:
                s = u8[i+2:i+2+ln].decode('utf-8')
                if s.isprintable() and s.strip():
                    out.append(s); i += 2 + ln; continue
            except Exception:
                pass
        i += 1
    return out

def wait_latest():
    while True:
        try:
            p = open(LATEST, encoding='utf-8').read().strip()
            if p and os.path.exists(p):
                return p
        except Exception:
            pass
        time.sleep(1)

def hhmmss(t):
    return time.strftime('%H:%M:%S', time.localtime(t / 1000))

def main():
    path = wait_latest()
    print(f'[digest] acompanhando {os.path.basename(path)}')
    f = open(path, 'r', encoding='utf-8')
    f.seek(0, 2)  # começa do fim: só o que vier a partir de agora
    win = {}      # (dir, header) -> {'n':, 'bytes':, 'strs': set}
    win_start = time.time()
    while True:
        # troca de arquivo (app reiniciado)
        try:
            newp = open(LATEST, encoding='utf-8').read().strip()
            if newp and newp != path and os.path.exists(newp):
                f.close(); path = newp; f = open(path, 'r', encoding='utf-8')
                print(f'[digest] novo arquivo de sessão: {os.path.basename(path)}')
        except Exception:
            pass
        line = f.readline()
        if not line:
            if win and time.time() - win_start >= WINDOW:
                flush(win); win = {}; win_start = time.time()
            time.sleep(0.3)
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        k = e.get('kind')
        if k == 'packet':
            key = (e['dir'], e['header'])
            w = win.setdefault(key, {'n': 0, 'bytes': 0, 'strs': set(), 'inj': False})
            w['n'] += 1; w['bytes'] += e.get('bodyLength', 0)
            if e.get('injected'): w['inj'] = True
            if 0 < e.get('bodyLength', 0) <= 4096:
                for s in strings_of(e.get('body', '')):
                    if len(w['strs']) < 6: w['strs'].add(s)
            if time.time() - win_start >= WINDOW:
                flush(win); win = {}; win_start = time.time()
        elif k == 'marker':
            if win: flush(win); win = {}; win_start = time.time()
            print(f"[{hhmmss(e['t'])}] ▶ MARCADOR: {e.get('text')}")
        elif k == 'socket':
            print(f"[{hhmmss(e['t'])}] ● socket #{e.get('socketId')} {e.get('event')} {e.get('url','')} {e.get('code','')} {e.get('reason','')}".rstrip())
        elif k == 'probe':
            found = ', '.join(f"{a}:{b}" for a, b in (e.get('found') or {}).items()) or 'nenhum global conhecido'
            keys = e.get('nitroConfigKeys')
            print(f"[{hhmmss(e['t'])}] ◆ SONDAGEM {e.get('href')} | socket={e.get('socketUrl')} | globais: {found}" + (f" | NitroConfig keys: {', '.join(keys[:40])}" if keys else ''))
        elif k == 'ready':
            print(f"[{hhmmss(e['t'])}] ✔ agente ativo em {e.get('href')}")
        elif k == 'error':
            print(f"[{hhmmss(e['t'])}] ✖ erro do agente: {e.get('message')}")
        elif k == 'session':
            print(f"[{hhmmss(e['t'])}] sessão {e.get('event')}")

def flush(win):
    parts_out, parts_in = [], []
    for (d, h), w in sorted(win.items(), key=lambda kv: -kv[1]['n']):
        s = f"{h}×{w['n']}"
        if w['inj']: s += '*'
        if w['strs']: s += '(' + ' | '.join(repr(x)[1:-1][:40] for x in sorted(w['strs'])[:4]) + ')'
        (parts_out if d == 'out' else parts_in).append(s)
    tot = sum(w['n'] for w in win.values())
    line = f"[{time.strftime('%H:%M:%S')}] +{tot} pkts"
    if parts_out: line += ' | ↑OUT ' + ' '.join(parts_out[:14])
    if parts_in: line += ' | ↓IN ' + ' '.join(parts_in[:14])
    print(line[:900])

if __name__ == '__main__':
    main()
