#!/usr/bin/env python3
"""PUBLIC_APP_URL — the one setting the login-code autofill hangs on.

The SMS only makes the phone offer the code when its last line is

    @<host> #<code>

and the API writes that line from PUBLIC_APP_URL. Unset, webOtpLine() returns
an empty string: the message goes out looking perfectly normal, the player sees
their code, and the phone never offers to type it — with nothing anywhere
saying why. That is what is being fixed here.

The host must be EXACTLY the origin the game is opened from. The site
redirects to the www form, so that is what goes in.

Run:   sudo python3 set-public-url.py
       sudo python3 set-public-url.py --apply

Without --apply it only shows what it would change.
"""
import io, os, re, shutil, subprocess, sys, time

HOST = 'www.' + 'prizequiz' + '.ir'          # split so no editor turns it into a link
VALUE = 'https://' + HOST
KEY = 'PUBLIC_APP_URL'
CANDIDATES = [
    '/home/ubuntu/docker-compose.override.yml',
    '/home/ubuntu/prizzequizz/docker-compose.override.yml',
    '/opt/prizzequizz/docker-compose.override.yml',
    './docker-compose.override.yml',
]

def find():
    for p in CANDIDATES:
        if os.path.isfile(p):
            return p
    return None

def main():
    apply = '--apply' in sys.argv
    path = find()
    if not path:
        print('could not find docker-compose.override.yml in any of:')
        for p in CANDIDATES:
            print('   ' + p)
        print('\nrun this from the directory that holds it, or add its path to CANDIDATES.')
        return 2
    print('compose file: ' + path)
    text = io.open(path, encoding='utf-8').read()

    if re.search(r'^\s*' + KEY + r'\s*:', text, re.M):
        cur = re.search(r'^\s*' + KEY + r'\s*:\s*(.+?)\s*$', text, re.M)
        print(KEY + ' is already set to: ' + (cur.group(1) if cur else '?'))
        print('nothing to change. if that value is not ' + VALUE + ', edit it by hand.')
        return 0

    # Find the api service and its environment block.
    m = re.search(r'^([ \t]*)api:[ \t]*$', text, re.M)
    if not m:
        print('no `api:` service in that file — not touching it. add by hand:')
        print('    ' + KEY + ': "' + VALUE + '"')
        return 2
    svc_indent = m.group(1)
    rest = text[m.end():]
    em = re.search(r'^([ \t]*)environment:[ \t]*$', rest, re.M)
    # The environment block has to belong to `api:`, not to a later service.
    nxt = re.search(r'^' + svc_indent + r'\S', rest, re.M)
    if em and (not nxt or em.start() < nxt.start()):
        indent = em.group(1) + '  '
        at = m.end() + em.end()
        new = text[:at] + '\n' + indent + KEY + ': "' + VALUE + '"' + text[at:]
        how = 'add to the existing environment: block'
    else:
        indent = svc_indent + '  '
        at = m.end()
        new = text[:at] + '\n' + indent + 'environment:\n' + indent + '  ' + KEY + ': "' + VALUE + '"' + text[at:]
        how = 'add a new environment: block'

    print('would ' + how + ':')
    print('    ' + KEY + ': "' + VALUE + '"')
    if not apply:
        print('\nnothing written. run again with --apply to write it.')
        return 0

    bak = path + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
    shutil.copy2(path, bak)
    io.open(path, 'w', encoding='utf-8').write(new)
    print('written. backup: ' + bak)

    # An env change needs `up -d`, not `restart`: restart reuses the container
    # with the environment it was created with, so the value would not arrive.
    print('\nrecreating the api container (up -d --no-build, NOT restart)…')
    r = subprocess.run(['docker', 'compose', '-p', 'prizzequizz', 'up', '-d', '--no-build', 'api'],
                       cwd=os.path.dirname(path) or '.', capture_output=True, text=True)
    print(r.stdout + r.stderr)
    if r.returncode != 0:
        print('compose failed — the file is changed; the backup is at ' + bak)
        return 1

    time.sleep(4)
    c = subprocess.run(['docker', 'compose', '-p', 'prizzequizz', 'exec', '-T', 'api', 'printenv', KEY],
                       cwd=os.path.dirname(path) or '.', capture_output=True, text=True)
    got = (c.stdout or '').strip()
    print('\ninside the container, ' + KEY + ' = ' + (got or '(still empty!)'))
    if got != VALUE:
        print('that is not what was written — check the file and the compose project name.')
        return 1
    print('\ndone. now: panel → پنل پیامکی → سرویس. the note at the bottom should be green.')
    print('then ask for a login code and look at the last message in the گزارش tab:')
    print('its final line must be   @' + HOST + ' #<code>')
    return 0

sys.exit(main())
