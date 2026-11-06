// Runs with no dependencies:
//   node --experimental-strip-types test/detect.test.mts
//
// The HIDE and KEEP lists are the contract. A change to a threshold or a
// pattern is only finished when both still pass, the round trips hold, and
// the timing checks stay inside the hook's budget.
//
// No key-shaped string is written out in this file: GitHub push protection
// rejects them, and a redactor reading this file would hide them. Every fake
// key is built at run time from a prefix in pieces and a seeded random body,
// so the run is the same every time. The number after each section heading
// is the audit finding it covers.
import { makeConfig, scrubSecrets, scrubPii, restore, mint, walk, escapeLiteralTags } from '../hooks/detect.ts'

const cfg = makeConfig({})
const piiCfg = makeConfig({ pii: true })
const scrub = (text: string): string => scrubSecrets(text, cfg)
const TAG = /\[REDACTED-(?:SECRET|EMAIL|LITERAL)-[0-9a-f]{8}\]/g
const tagCount = (text: string): number => text.match(TAG)?.length ?? 0

// ------------------------------------------------------------ fake values

// mulberry32: a small seeded generator, so every fake is the same each run.
let seed = 0x5eed1234
function rand(): number {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGIT = '0123456789'
const HEX = '0123456789abcdef'
const B62 = UPPER + LOWER + DIGIT
const B64 = B62 + '+/'
const pick = (abc: string, n: number): string => {
  let s = ''
  for (let i = 0; i < n; i++) s += abc[Math.floor(rand() * abc.length)]
  return s
}
// A random body that is sure to hold one of each of the given classes.
const mixed = (n: number, abc = B62, need = [LOWER, UPPER, DIGIT]): string => {
  const chars = pick(abc, n - need.length).split('')
  for (const c of need) chars.splice(Math.floor(rand() * (chars.length + 1)), 0, pick(c, 1))
  return chars.join('')
}
const hex = (n: number): string => mixed(n, HEX, ['abcdef', DIGIT])
const lowerDigit = (n: number): string => mixed(n, LOWER + DIGIT, [LOWER, DIGIT])
const letters = (n: number): string => mixed(n, UPPER + LOWER, [LOWER, UPPER])
const uuid = (): string => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`
const b64 = (text: string): string => Buffer.from(text, 'latin1').toString('base64')
const randomB64 = (bytes: number): string => {
  const a = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) a[i] = Math.floor(rand() * 256)
  return Buffer.from(a).toString('base64')
}
// A 40-character standard base64 secret with a `/` in the middle.
const slashKey = (): string => mixed(19, B64) + '/' + mixed(20, B64)

const sk = 's' + 'k'
const ANTHROPIC = `${sk}-ant-api03-${mixed(40, B62 + '_-')}`
const OPENAI_PROJ = `${sk}-proj-${mixed(48)}`
const GITHUB = 'gh' + 'p_' + mixed(36)
const STRIPE_LIVE = `${sk}_live_${mixed(28)}`
const AWS_ID = 'AK' + 'IA' + pick(UPPER + DIGIT, 16)
const GOOGLE = 'AI' + 'za' + mixed(35, B62 + '_-')
const pemBody = (): string => Array.from({ length: 6 }, () => randomB64(48)).join('\n')
const PEM_BEGIN = (label: string): string => '-----BEGIN ' + label + ' PRIVATE ' + 'KEY-----'
const PEM_END = (label: string): string => '-----END ' + label + ' PRIVATE ' + 'KEY-----'
const JWT = 'ey' + 'J' + mixed(20) + '.ey' + 'J' + mixed(40) + '.' + mixed(43, B62 + '_-')

// --------------------------------------------------------------- the lists

type Hide = [label: string, text: string, secret: string]
const HIDE: Hide[] = []
const hide = (label: string, text: string, secret = text): void => void HIDE.push([label, text, secret])
const KEEP: [string, string][] = []
const keep = (label: string, text: string): void => void KEEP.push([label, text])

// The original contract.
{
  const imp = 'imp' + '_' + hex(40)
  hide('prefix and 40 hex', `IMPELLO_KEY is ${imp}`, imp)
  hide('anthropic', `ANTHROPIC_API_KEY=${ANTHROPIC}`, ANTHROPIC)
  hide('github', `export GITHUB_TOKEN=${GITHUB}`, GITHUB)
  hide('aws id', `aws_access_key_id = ${AWS_ID}`, AWS_ID)
  hide('stripe live', `STRIPE_SECRET=${STRIPE_LIVE}`, STRIPE_LIVE)
  const dbpw = 'S3cur3-p4ss-' + lowerDigit(8)
  hide('postgres url password', `db: postgres://acs:${dbpw}@db.example.com:5432/main`, dbpw)
  hide('bearer jwt', `Authorization: Bearer ${JWT}`, JWT)
  const r2 = mixed(32)
  hide('quoted named', `R2_SECRET_ACCESS_KEY="${r2}"`, r2)
  const bare = mixed(32)
  hide('bare high entropy', `a bare high-entropy token ${bare} here`, bare)
  hide('google', GOOGLE)
  hide('pem block', `${PEM_BEGIN('RSA')}\n${pemBody()}\n${PEM_END('RSA')}`)
}
hide('email (pii)', 'contact me at ray@agenticcoding.example', 'ray@agenticcoding.example')

keep('git sha', `commit ${hex(40)} landed on main`)
keep('docker digest', `sha256:${hex(64)}`)
keep('path', 'apps/nextjs/src/components/agentengineer/school/school-styles.ts')
keep('localhost', 'http://localhost:3000/api/auth and 127.0.0.1:5432')
keep('ips', 'private net 192.168.1.14 and 10.0.0.7, public 91.198.174.192')
keep('ipv6', 'v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 seen')
keep('noreply', 'Co-Authored-By: Claude <noreply@anthropic.com>')
keep('github noreply', 'ray-amjad@users.noreply.github.com')
keep('version', 'Claude Code 2.1.260 released 2026-09-04')
keep('constants', 'const IN_FLIGHT = new Set([QUEUED, BUILDING, INITIALIZING])')
keep('npm', 'npm install @anthropic-ai/claude-code --save-dev')
keep('env name', 'PLANETSCALE_DATABASE_URL is set in Infisical prod')
keep('stripe ids', `monthly: "price_${mixed(24)}", productId: "prod_${mixed(14)}"`)
keep('stripe promo', `only promo_${mixed(24)} is active`)
keep('publishable', `pk_live_${mixed(40)}`)
keep('kebab name', 'key="archived-modules-marker"')
keep('snake name', 'const OUTLINE_OPEN_KEY = "lesson_article_outline_open_v1";')
keep('camel import', 'import { playerEventBatchV1Schema } from "./player-event-ingest";')
keep('camel function', 'export function randomTimestampWithinLast14Days(): string {')
keep('naming convention', 'META_Conv_Lookalike-Customers_FreeTrial_2024Q1')
keep('alphabet', 'const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";')
keep('utm', 'utm_source=youtube&utm_medium=video_description&utm_campaign=launch')
keep('example emails', 'placeholder="you@example.com" and name@company.com')
keep('dated slug under a key name', '"session": "2026-10-12-lesson",')
keep('url password in docs', 'postgres://user:PASSWORD@host:5432/db')
keep('curl -u in a code span', 'Credentials on a command line: `curl -u user:pw`, `mysql -pPW`')
keep('base64 alphabet', "const abc = '" + UPPER + LOWER + DIGIT + "+/'")

// 0 and 8. Word-like prefixes, and random `-` or `_` inside a key body.
{
  const shapes: [string, string][] = [
    ['vercel blob', 'vercel_' + 'blob_rw_' + mixed(16) + '_' + mixed(30)],
    ['tailscale', 'tskey' + '-auth-' + 'k' + mixed(10) + 'CNTRL-' + mixed(33)],
    ['planetscale oauth', 'pscale' + '_oauth_' + mixed(43)],
    ['pinecone', 'pcsk' + '_' + mixed(5) + '_' + mixed(20) + '-' + mixed(25)],
    ['docker', 'dckr' + '_pat_' + 'QwErTy-' + mixed(20)],
    ['figma', 'figd' + '_' + mixed(20) + '-' + mixed(19)],
    ['google oauth', 'GOCSPX' + '-AbCd_' + mixed(23)],
    ['supabase', 'sb' + '_secret_' + mixed(12) + '-' + mixed(12)],
  ]
  for (const [label, key] of shapes) hide(label, `SOME_TOKEN=${key}`, key)
  keep('timestamped name', 'build-artifacts-20261012T101530Z-run42')
}

// 1 and 18. Keys that reuse a Stripe id prefix; a name overrides only test_/tok_.
{
  const resend = 're' + '_' + mixed(8) + '_' + mixed(24)
  hide('resend named', `RESEND_API_KEY=${resend}`, resend)
  const wc = 'cs' + '_' + hex(40)
  hide('woocommerce secret', `WC_CONSUMER_SECRET=${wc}`, wc)
  const pi = 'pi' + '_' + mixed(24) + '_secret_' + mixed(25)
  hide('stripe client secret', `"client_secret": "${pi}"`, pi)
  const t = 'test' + '_' + mixed(32)
  hide('test_ under a key name', `API_KEY=${t}`, t)
  const tok = 'tok' + '_' + mixed(32)
  hide('tok_ under a key name', `token=${tok}`, tok)
  keep('stripe checkout', `"session": "cs_test_${mixed(58)}"`)
  keep('publishable under key', `STRIPE_PUBLISHABLE_KEY="pk_test_${mixed(40)}"`)
  keep('price under key', `STRIPE_PRO_PRICE_KEY=price_${mixed(24)}`)
}

// 2. The secret half after `.`, `:` or `/`.
{
  const airtable = 'pat' + mixed(14) + '.' + hex(64)
  hide('airtable', `AIRTABLE_TOKEN=${airtable}`, airtable)
  const mapbox = sk + '.eyJ1Ijoi' + mixed(40) + '.' + mixed(22)
  hide('mapbox', `MAPBOX_TOKEN=${mapbox}`, mapbox)
  const inf = 's' + 't.' + uuid() + '.' + hex(32) + '.' + hex(32)
  hide('infisical', inf)
  const asana = '2/' + pick(DIGIT, 16) + '/' + pick(DIGIT, 16) + ':' + hex(32)
  hide('asana', `ASANA=${asana}`, asana)
  const fal = uuid() + ':' + hex(32)
  hide('fal', `FAL_KEY=${fal}`, fal)
}

// 3. Hugging Face tokens are letters only.
{
  const hf = 'h' + 'f_' + letters(34)
  hide('hugging face', `HF_TOKEN=${hf}`, hf)
  hide('hugging face org', 'api' + '_org_' + letters(34))
  keep('hf function', 'from huggingface_hub import hf_hub_download')
}

// 4 and 14. Standard base64 with `/`, and URL-encoded secrets.
{
  for (let i = 0; i < 3; i++) {
    const aws = slashKey()
    hide(`aws secret ${i}`, `aws_secret_access_key = ${aws}`, aws)
  }
  const json = slashKey()
  hide('aws secret in json', `"SecretAccessKey": "${json}"`, json)
  const openssl = mixed(21, B64) + '/' + mixed(21, B64)
  hide('openssl base64', `generated ${openssl}= for you`, openssl)
  const azure = mixed(40, B64) + '/' + mixed(45, B64)
  hide('azure storage key', `AccountKey=${azure}==;EndpointSuffix=core.windows.net`, azure)
  const tw = 'A'.repeat(21) + mixed(30) + '%3D' + mixed(40)
  hide('twitter bearer', `Bearer ${tw}`, tw.slice(21))
  const sas = mixed(20) + '%2B' + mixed(12) + '%2F' + mixed(10) + '%3D'
  hide('azure sas', `https://acct.blob.core.windows.net/c/f?sv=2024&sig=${sas}`, sas)
  const basic = b64('admin:' + mixed(14))
  hide('basic auth', `Authorization: Basic ${basic}`, basic)
  keep('dated path', 'uploads/2026/10/12/Report2Final/Q3Summary/Draft7')
}

// 5 and 12. A name separated by a space: Bearer, Token, CLI flags, tables.
{
  const h32 = hex(32)
  hide('bearer hex', `curl -H "Authorization: Bearer ${h32}"`, h32)
  const u = uuid()
  hide('token uuid', `Authorization: Token ${u}`, u)
  const gh40 = hex(40)
  hide('authorization token hex', `curl -H "Authorization: token ${gh40}"`, gh40)
  const a = hex(32)
  hide('--api-key hex', `cli deploy --api-key ${a}`, a)
  const c = uuid()
  hide('--token uuid', `mytool deploy --token ${c}`, c)
  const d = lowerDigit(20)
  hide('--password', `mysql --password ${d}`, d)
  const tab = lowerDigit(32)
  hide('table cell', `| API_KEY | ${tab} |`, tab)
  keep('cache key flag', `--cache-key ${hex(40)}`)
  keep('idempotency flag', `stripe --idempotency-key ${uuid()}`)
  keep('token variable', '--token $GITHUB_TOKEN')
  keep('token braces', '--token ${VERCEL_TOKEN}')
  keep('actions secret', '--api-key ${{ secrets.X }}')
  keep('help text', '--password PASSWORD and --token TOKEN')
  keep('placeholder flag', '--api-key <your-api-key>')
  keep('docker secret', 'docker build --secret id=npmrc,src=.npmrc .')
  keep('default password prose', 'The default password policy requires 12 chars')
}

// 6. Lowercase and hex shapes that one vendor owns.
{
  const shapes: [string, string][] = [
    ['e2b', 'e2b' + '_' + hex(40)],
    ['langsmith', 'lsv2' + '_pt_' + hex(32) + '_' + hex(10)],
    ['mailchimp', hex(32) + '-us' + '12'],
    ['mailgun new', hex(32) + '-' + hex(8) + '-' + hex(8)],
    ['axiom', 'xa' + 'at-' + uuid()],
    ['twilio', 'S' + 'K' + hex(32)],
    ['mailgun legacy', 'key' + '-' + hex(32)],
    ['shopify', 'shpss' + '_' + hex(32)],
    ['neon', 'napi' + '_' + lowerDigit(64)],
    ['firecrawl', 'fc' + '-' + hex(32)],
    ['tavily', 'tvly' + '-dev-' + lowerDigit(32)],
  ]
  for (const [label, key] of shapes) hide(label, `value ${key} here`, key)
  keep('sha256 digest', 'sha256-' + hex(64))
  keep('md5 digest', 'md5-' + hex(32))
  keep('uuid', `request ${uuid()} done`)
}

// 7. Keys with no digit.
{
  const trig = 'tr' + '_dev_' + letters(20)
  hide('trigger.dev', trig)
  const vercel = letters(24)
  hide('letters-only named', `VERCEL_TOKEN=${vercel}`, vercel)
}

// 9 and 32. A vendor prefix inside a word is not a key; after an escape it is.
{
  keep('task word', 'npm run ta' + 'sk-runner-for-the-build-pipeline')
  keep('risk word', 'see ri' + 'sk-assessment-matrix-template-final.md')
  keep('desk word', 'de' + 'sk-setup-recommendations-page-v2')
  hide('sk after escaped newline', `{"log":"key\\n${OPENAI_PROJ}"}`, OPENAI_PROJ)
  const aws = 'AK' + 'IA' + pick(UPPER + DIGIT, 16)
  hide('aws after escaped newline', `"a\\n${aws}"`, aws)
}

// 11. Human passwords, judged by the key, not by entropy.
{
  const pws: [string, (v: string) => string, string][] = [
    ['env password', (v) => `DB_PASSWORD=${v}`, 'Summer' + '2024!'],
    ['quoted phrase', (v) => `ADMIN_PASSWORD="${v}"`, 'correcthorse' + 'batterystaple'],
    ['json password', (v) => `{"password": "${v}"}`, 'P@ss' + 'w0rd!'],
    ['yaml password', (v) => `db:\n  password: ${v}`, 'changeme' + '123'],
    ['ado.net', (v) => `Server=x;User Id=sa;Password=${v};`, 'Winter' + '2025'],
    ['pgpassword', (v) => `PGPASSWORD=${v} psql`, lowerDigit(12)],
  ]
  for (const [label, wrap, v] of pws) hide(label, wrap(v), v)
  keep('pwd env', 'PWD=/Users/ray/Desktop/ray-os')
  keep('self ref call', 'connect(user=user, password=password)')
  keep('self ref object', '  apiKey: apiKey,')
  keep('placeholder value', 'api_key=YOUR_API_KEY')
  keep('ts type', '  password: string')
  keep('env reference', 'secret: process.env.SECRET')
}

// 10. Round trips through URL userinfo: scrub then restore gives the input
// back, and a second scrub changes nothing.
const ROUND_TRIP: string[] = [
  `git remote set-url origin https://x-access-token:${'gh' + 's_' + mixed(36)}@github.com/o/r.git`,
  `HTTPS_PROXY=http://user:${sk}-${mixed(40)}@proxy.local:3128`,
  `postgresql://postgres:${JWT}@db.example.com/main`,
  `https://u:abc${'gh' + 's_' + mixed(36)}@host.io/x`,
]

// 13. Escaped JSON and HTML entities do not hide the key name.
{
  const a = lowerDigit(32)
  hide('json in a string', `{"body": "{\\"api_key\\": \\"${a}\\"}"}`, a)
  const c = lowerDigit(32)
  hide('html entity', `{&quot;token&quot;: &quot;${c}&quot;}`, c)
  const e = lowerDigit(32)
  hide('numeric entity', `&#34;token&#34;: &#34;${e}&#34;`, e)
}

// 15. URL passwords with an empty user, or a raw `/` or `@`.
{
  const r = mixed(20)
  hide('empty user', `redis://:${r}@cache.example.org:6379/0`, r)
  const s = mixed(8) + '/' + mixed(8)
  hide('slash in password', `postgresql://app:${s}@db.example.org/main`, s)
  keep('vite ipv6', 'http://[::1]:5173/@vite/client')
  keep('query with at', 'http://localhost:3000?next=a@b.co')
  keep('jsdelivr', 'https://cdn.jsdelivr.net/npm/pkg@1.2.3/dist/x.js')
}

// 16. A key id beside `key_id`.
{
  const a = hex(40)
  hide('private_key_id', `"private_key_id": "${a}"`, a)
  const b = hex(40)
  hide('access key id', `ACCESS_KEY_ID=${b}`, b)
  keep('commit id', `"commit_id": "${hex(40)}"`)
}

// 17. Session cookies.
{
  const a = lowerDigit(32)
  hide('django cookie', `Cookie: csrftoken=abc; sessionid=${a}`, a)
  const b = lowerDigit(32)
  hide('session_id cookie', `Cookie: session_id=${b}`, b)
  const c = mixed(26, 'abcdefghijklmnopqrstuv' + DIGIT, ['abcdef', DIGIT])
  hide('php cookie', `Cookie: PHPSESSID=${c}`, c)
  const d = mixed(32, UPPER + DIGIT, [UPPER, DIGIT])
  hide('java cookie', `Set-Cookie: JSESSIONID=${d}; Path=/; HttpOnly`, d)
  const f = lowerDigit(32)
  hide('cookies.txt', `.example.org\tTRUE\t/\tTRUE\t0\tsid\t${f}`, f)
  keep('ga cookie', 'Cookie: _ga=GA1.2.1234567890.1700000000')
  keep('word cookie', 'Cookie: theme=dark-mode-v2-enabled')
  keep('transcript session id', `{"sessionId":"${uuid()}","type":"user"}`)
}

// 19. A named key with word parts in front.
{
  const a = lowerDigit(32)
  hide('live-secret', `SECRET=live-secret-${a}`, a)
  const b = lowerDigit(32)
  hide('prod_api_key_', `API_KEY=prod_api_key_${b}`, b)
  const dj = 'django' + '-insecure-' + pick(LOWER + DIGIT + '!@#$%^&*(-_=+)', 50)
  hide('django key', `SECRET_KEY='${dj}'`, dj)
}

// 20. PGP blocks, truncated PEM output, PuTTY bodies.
{
  const pgp = '-----BEGIN PGP PRIVATE ' + 'KEY BLOCK-----\nVersion: GnuPG v2\n\n' + pemBody() + '\n-----END PGP PRIVATE ' + 'KEY BLOCK-----'
  hide('pgp block', pgp)
  const trunc = PEM_BEGIN('RSA') + '\n' + pemBody()
  hide('truncated pem', `$ head -7 key.pem\n${trunc}\n$ ls`, trunc.split('\n')[3]!)
  const ppk = 'PuTTY-User-Key-File-3: ssh-rsa\nPrivate-Lines: 3\n' + randomB64(48) + '\n' + randomB64(48) + '\n' + randomB64(30) + '\nPrivate-MAC: ' + hex(64)
  hide('putty', ppk, ppk.split('\n')[2]!)
  keep('pem prose', 'The file starts with a BEGIN line and ends with the END marker.')
}

// 21. Credential query parameters.
{
  const tok = mixed(10) + '%2F' + mixed(10) + '%2B' + mixed(6)
  hide('accessToken', `https://api.example.org/v1?accessToken=${tok}&x=1`, tok)
  keep('sort key', 'https://x.io/list?sort_key=created_at_desc&page=2')
  keep('api_key placeholder', 'https://x.io/v1?api_key=YOUR_API_KEY')
}

// 22. curl -u, mysql -p, .pgpass.
{
  const a = lowerDigit(14)
  hide('curl -u', `curl -u admin:${a} https://x.example.org`, a)
  const c = 'Tr0ub' + '4dor&3'
  hide('mysql -p', `mysql -u root -p${c} db`, c)
  const d = mixed(18)
  hide('pgpass', `db.example.org:5432:main:app:${d}`, d)
  keep('date -u', 'date -u +%Y-%m-%dT%H:%M:%SZ')
  keep('docker -u', 'docker exec -u node:node app sh')
  keep('curl -u vars', 'curl -u $USER:$TOKEN https://x.io')
  keep('linter output', 'file.ts:120:7:error:TS2304 cannot find name')
}

// 24. Smaller contexts.
{
  const a = lowerDigit(32)
  hide('yaml block scalar', `api_key: >-\n    ${a}\n`, a)
  const gh = lowerDigit(32)
  hide('gh secret set', `gh secret set API_KEY --body ${gh}`, gh)
  const n = lowerDigit(24)
  hide('netrc', `machine api.example.org\n  login ray\n  password ${n}\n`, n)
  keep('gh secret var', 'gh secret set API_KEY --body "$API_KEY"')
}

// 26 to 29, 31, 33, 35, 46. Big opaque blobs and public ids are left whole,
// not shredded into placeholders.
const BLOBS: [label: string, text: string][] = []
{
  const boundary = '_----' + mixed(22)
  const eml = [
    'From: a@example.com',
    'Subject: =?UTF-8?B?' + randomB64(30) + '?=',
    'Message-ID: <' + mixed(40) + '@mail.example.com>',
    'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=s1;',
    '\tbh=' + randomB64(32) + ';',
    '\tb=' + randomB64(64) + randomB64(64),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    '',
    '--' + boundary,
    'Content-Type: application/pdf; name="r.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    randomB64(6000).replace(/.{76}/g, '$&\n'),
    '',
    `--${boundary}--`,
  ].join('\n')
  BLOBS.push(['eml attachment and headers', eml])
  BLOBS.push(['data uri png', `<img src="data:image/png;base64,${randomB64(3000)}">`])
  BLOBS.push(['thinking signature', `{"type":"thinking","thinking":"","signature":"${randomB64(1200)}"}`])
  BLOBS.push(['lockfile', `"integrity": "sha512-${randomB64(64)}"`])
  BLOBS.push(['sri', `<script integrity="sha384-${randomB64(48)}"></script>`])
  BLOBS.push(['1 MB base64', randomB64(750_000)])
  BLOBS.push(['monzo rows', `tx_0000${mixed(18)},2026-01-01,-4.20\nmm_0000${mixed(18)},2026-01-02,10.00`])
  BLOBS.push(['vercel deployment id', `&dpl=dpl_${mixed(28)}`])
}
// Blobs that ARE secrets are still hidden.
{
  const pem = PEM_BEGIN('RSA') + '\n' + pemBody() + '\n' + PEM_END('RSA') + '\n'
  hide('kubeconfig client key', `    client-key-data: ${b64(pem)}`, b64(pem).slice(0, 60))
  const sa = JSON.stringify({ type: 'service_' + 'account', private_key: pem })
  hide('service account env', `GOOGLE_CREDENTIALS_BASE64=${b64(sa)}`, b64(sa).slice(0, 60))
  const key = mixed(40)
  hide('key after data uri prefix', `data:image/png;base64,${key}`, key)
  const think = `${sk}-ant-api03-${mixed(40)}`
  hide('key inside thinking text', `{"type":"thinking","thinking":"use ${think}","signature":"${randomB64(900)}"}`, think)
  const forged = mixed(40)
  hide('short forged signature', `{"type":"thinking","signature":"${forged}"}`, forged)
  const glued = mixed(40)
  hide('key glued to sha256-', `sha256-${glued}`, glued)
}

// 30 and 34. `=` before a value, percent residue.
{
  keep('receipt name', `receipt_2026-01-01_expenseID=${uuid()}.pdf`)
  keep('uuid after %3D', `pd_rd_r%3D${uuid()}&x=1`)
  const k = mixed(40)
  hide('key after double-encoded =', `api_key%253D${k}`, k)
}

// 38. JWTs glued to a word.
hide('jwt after prefix', `jwt_${JWT}`, JWT)

// ------------------------------------------------ red team, version 0.3.0
// The number after each heading is the red team finding it covers.

const wrap = (text: string, width: number): string => text.match(new RegExp(`.{1,${width}}`, 'g'))!.join('\n')
const b64url = (text: string): string => b64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const humanPw = (): string => 'Summer' + pick(DIGIT, 4) + '!' + mixed(4)
const genPw = (n: number): string => mixed(n, B62 + '!#$%&*()-_=+[]{}<>:?', [LOWER, UPPER, DIGIT, '!#%&*=+'])

// R1. Base64 of a .env, a config file or a mail body that holds a key is
// hidden whole, not parked. Base64 of plain text stays parked.
{
  const env = (): string => `OPENAI_API_KEY=${sk}-proj-${mixed(48)}\nSTRIPE_SECRET_KEY=${sk}_live_${mixed(24)}\nDATABASE_URL=postgres://app:${mixed(20)}@db.internal:5432/app\n`
  const e1 = b64(env())
  hide('R1 kubectl secret yaml', `apiVersion: v1\ndata:\n  .env: ${e1}\nkind: Secret\n`, e1)
  const e2 = b64(env())
  hide('R1 base64 .env wrapped at 76', wrap(e2, 76) + '\n', e2.slice(0, 76))
  const e3 = b64(env())
  hide('R1 github contents wrapped at 60', `{"encoding":"base64","content":"${wrap(e3, 60).replace(/\n/g, '\\n')}"}`, e3.slice(0, 60))
  const mail = b64('Hello,\n' + 'Thanks for signing up for the developer plan. '.repeat(6) + `\n\nYour key: ${sk}-proj-${mixed(48)}\n`)
  hide('R1 eml text/plain base64 body', `Content-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: base64\n\n${wrap(mail, 76)}\n`, mail.slice(0, 76))
  const cfgJson = b64(JSON.stringify({ openai: { apiKey: `${sk}-proj-${mixed(48)}` }, note: 'x'.repeat(40) }, null, 2))
  hide('R1 narrow attachment', `--b1\nContent-Type: application/octet-stream; name="config.json"\nContent-Transfer-Encoding: base64\n\n${wrap(cfgJson, 48)}\n--b1--\n`, cfgJson.slice(0, 48))
  BLOBS.push(['R1 base64 of a plain mail body', `Content-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: base64\n\n${wrap(b64('Hello,\n' + 'Your order has shipped and will arrive on Tuesday. '.repeat(12)), 76)}\n`])
  BLOBS.push(['R1 base64 of a plain text file', wrap(b64('Meeting notes from the planning call. '.repeat(20)), 76) + '\n'])
}

// R2, R3, R5. Vendor shapes that are not mixed case or reuse a public prefix.
{
  const klaviyo = 'pk' + '_' + mixed(34, LOWER + DIGIT, [LOWER, DIGIT])
  hide('R2 klaviyo under a key name', `KLAVIYO_API_KEY=${klaviyo}`, klaviyo)
  const k2 = 'pk' + '_' + mixed(34, LOWER + DIGIT, [LOWER, DIGIT])
  hide('R2 klaviyo in its header', `Authorization: Klaviyo-API-Key ${k2}`, k2)
  const k3 = 'pk' + '_' + mixed(34, LOWER + DIGIT, [LOWER, DIGIT])
  hide('R2 klaviyo under "private_key"', `{"private_key": "${k3}"}`, k3)
  const age = 'AGE-SEC' + 'RET-KEY-1' + pick(UPPER + DIGIT, 58)
  hide('R3 age keys.txt', `# created: 2026-01-01T00:00:00Z\n# public key: age1${pick(LOWER + DIGIT, 58)}\n${age}\n`, age.slice(16))
  const shapes: [string, string][] = [
    ['R5 new relic', 'NR' + 'AK-' + pick(UPPER + DIGIT, 27)],
    ['R5 dynatrace', 'dt0' + 'c01.' + pick(UPPER + DIGIT, 24) + '.' + pick(UPPER + DIGIT, 64)],
    ['R5 hubspot', 'pat' + '-na1-' + uuid()],
    ['R5 launchdarkly', 'sd' + 'k-' + uuid()],
    ['R5 linear oauth', 'lin' + '_oauth_' + hex(64)],
    ['R5 shippo', 'shi' + 'ppo_live_' + hex(40)],
    ['R5 databricks', 'da' + 'pi' + hex(32)],
    ['R5 deepl', uuid() + ':' + 'fx'],
    ['R5 braintree', 'access' + '_token$production$' + lowerDigit(16) + '$' + hex(32)],
  ]
  for (const [label, key] of shapes) hide(label, `client = Client("${key}")`, key)
  const ado = mixed(52, 'abcdefghijklmnopqrstuvwxyz234567', [LOWER, '234567'])
  hide('R5 R14 azure devops pat env', `export AZURE_DEVOPS_EXT_PAT=${ado}`, ado)
  const ado2 = mixed(52, 'abcdefghijklmnopqrstuvwxyz234567', [LOWER, '234567'])
  hide('R14 azure devops pat in clone url', `git clone https://${ado2}@dev.azure.com/org/proj/_git/repo`, ado2)
  keep('R5 PATH is not PAT', 'PATH=/usr/local/bin:/usr/bin:/bin')
  keep('R5 stripe publishable stays public', `const pk = "pk_live_${mixed(24)}"`)
}

// R4, R11. A vendor scheme after Authorization, or none; sibling name fields.
{
  const a = uuid()
  hide('R4 GenieKey scheme', `curl -H "Authorization: GenieKey ${a}"`, a)
  const b = hex(40)
  hide('R4 R11 raw hex after Authorization', `> GET /v1 HTTP/1.1\n> Authorization: ${b}\n`, b)
  const c = hex(32)
  hide('R11 k8s env pair hex', `env:\n  - name: DD_API_KEY\n    value: "${c}"\n`, c)
  const d = humanPw()
  hide('R11 k8s env pair password', `env:\n  - name: DB_PASSWORD\n    value: ${d}\n`, d)
  const e = hex(32)
  hide('R11 HAR header pair', `{"headers":[{"name":"x-api-key","value":"${e}"}]}`, e)
  const f = humanPw()
  hide('R11 HAR form pair', `{"params":[{"name":"password","value":"${f}"}]}`, f)
  const g = humanPw()
  hide('R11 tfstate sensitive output', `"outputs": {\n  "db_password": {\n    "value": "${g}",\n    "type": "string",\n    "sensitive": true\n  }\n}`, g)
  const h = hex(32)
  hide('R11 go header map', `req headers: map[Accept:[*/*] X-Api-Key:[${h}]]`, h)
  const i = hex(32)
  hide('R11 python header tuple', `headers=[('X-Api-Key', '${i}'), ('Accept', '*/*')]`, i)
  const j = hex(40)
  hide('R11 sql insert column', `INSERT INTO api_keys (id, user_id, key) VALUES (1, 2, '${j}');`, j)
  const k = hex(32)
  hide('R11 twilio positional', `client = Client("AC${hex(32)}", "${k}")`, k)
  keep('R11 json name/value that is not a key', '{"name":"content-type","value":"application/json"}')
  keep('R11 sql insert with no key column', "INSERT INTO users (id, name) VALUES (1, 'Ada Lovelace');")
}

// R6, R7, R9, R13. Human passwords on command lines and under short names.
{
  const cmds: [string, (v: string) => string][] = [
    ['R6 sshpass', (v) => `sshpass -p ${v} ssh app@host`],
    ['R6 sqlcmd', (v) => `sqlcmd -S db -U sa -P ${v}`],
    ['R6 redis-cli', (v) => `redis-cli -h cache -a ${v} ping`],
    ['R6 openssl pass:', (v) => `openssl pkcs12 -export -passout pass:${v} -out x.p12`],
    ['R6 docker login', (v) => `docker login -u ray -p ${v} registry.example.org`],
    ['R6 ldapsearch', (v) => `ldapsearch -x -D cn=admin -w ${v} -b dc=x`],
    ['R6 7z', (v) => `7z a -p${v} backup.7z dir`],
    ['R6 zip', (v) => `zip -r -P ${v} out.zip dir`],
    ['R6 smbclient', (v) => `smbclient //srv/share -U ray%${v}`],
    ['R6 htpasswd', (v) => `htpasswd -b .htpasswd ray ${v}`],
    ['R6 rabbitmqctl', (v) => `rabbitmqctl add_user app ${v}`],
    ['R6 mongosh', (v) => `mongosh -u admin -p ${v} --host db`],
    ['R6 net user', (v) => `net user app ${v} /add`],
    ['R7 nodemailer pass', (v) => `auth: { user: 'me@corp.io', pass: '${v}' }`],
    ['R7 json pass', (v) => `{"user": "app", "pass": "${v}"}`],
    ['R7 json pwd', (v) => `{"pwd": "${v}"}`],
    ['R7 REDIS_PW', (v) => `REDIS_PW=${v}`],
    ['R7 DB_PASSCODE', (v) => `DB_PASSCODE=${v}`],
    ['R9 ado.net Pwd=', (v) => `Server=db;Database=app;User Id=sa;Pwd=${v};`],
    ['R13 yaml list item', (v) => `users:\n  - password: ${v}\n    name: app\n`],
    ['R13 compose list env', (v) => `environment:\n  - DB_PASS=${v}\n`],
    ['R13 lowercase db_pass', (v) => `db:\n  db_pass: ${v}\n`],
    ['R13 yaml block scalar', (v) => `password: |\n  ${v}\n`],
    ['R13 hcl default', (v) => `variable "db_password" {\n  type    = string\n  default = "${v}"\n}\n`],
    ['R13 sql create user', (v) => `CREATE USER app WITH PASSWORD '${v}';`],
    ['R13 mysql identified by', (v) => `CREATE USER 'app'@'%' IDENTIFIED BY '${v}';`],
    ['R13 ssh ProxyCommand sshpass', (v) => `Host bastion\n  ProxyCommand sshpass -p ${v} ssh -W %h:%p jump\n`],
  ]
  for (const [label, wrapIt] of cmds) {
    const v = humanPw()
    hide(label, wrapIt(v), v)
  }
  const app = [pick(LOWER, 4), pick(LOWER, 4), pick(LOWER, 4), pick(LOWER, 4)].join(' ')
  hide('R13 smtp app password with spaces', `SMTP_PASSWORD=${app}\n`, app)
  const gmail = pick(LOWER, 16)
  hide('R7 gmail app password under pass', `auth: { user: 'me@corp.io', pass: '${gmail}' }`, gmail)
  const k8s = b64(humanPw())
  hide('R13 k8s secret data db-pass', `kind: Secret\ndata:\n  db-pass: ${k8s}\n`, k8s)
  keep('R6 password from stdin', 'echo "$PW" | docker login -u ray --password-stdin registry.example.org')
  keep('R6 redis-cli variable', 'redis-cli -a $REDIS_PASSWORD ping')
  keep('R6 ssh port flag', 'ssh -p 2222 app@host')
  keep('R6 zip recursive', 'zip -r out.zip dir')
  keep('R7 compass is not pass', 'compass: northwest-heading-v2')
  keep('R7 bypass flag', 'bypass: true')
  keep('R7 a test count', 'pass: 120\nfail: 0')
  keep('R7 pwd path', 'pwd: ./build/output')
  keep('R13 sql password prose', 'Set a strong password for the admin user.')
}

// R10. A value hidden at one spot is hidden at its other spots in the same text.
{
  const a = hex(32)
  hide('R10 HAR url and queryString', `{"url":"https://api.x.io/v1?api_key=${a}","queryString":[{"name":"q","value":"${a}"}]}`, a)
  const b = humanPw()
  hide('R10 named, then bare later', `password: ${b}\n...\nretrying login for app with ${b}\n`, b)
  keep('R10 a word hidden in a url is not hidden everywhere', 'docker run postgres:16 && psql postgres')
}

// R12. Generated passwords with symbols.
{
  const a = genPw(16)
  hide('R12 tfstate random_password', `{"type":"random_password","instances":[{"attributes":{"length":16,"result":${JSON.stringify(a)},"special":true}}]}`, a)
  const b = genPw(24)
  hide('R12 under token:', `token: "${b}"`, b)
  const c = '!' + genPw(19)
  hide('R12 pass: starting with !', `const cfg = { user: "app", pass: ${JSON.stringify(c)} }`, c)
  const d = 'ab(' + genPw(17)
  hide('R12 starts like a call', `{"result": "${d}"}`.replace('result', 'db_password'), d)
  const e = genPw(20)
  hide('R12 PGPASSWORD quoted', `PGPASSWORD='${e}' psql -h db`, e)
  const f = genPw(20)
  hide('R12 quoted with no name', `const x = ["${f}"]`, f)
  keep('R12 keyboard shortcut', '{ "key": "Ctrl+Alt+F12", "when": "editorFocus" }')
  keep('R12 regex string', 'const re = new RegExp("^[A-Za-z0-9]+$")')
  keep('R12 mime boundary', `Content-Type: multipart/alternative; boundary="=-${mixed(22)}=="`)
  keep('R12 payee with order number', '"payee": "Merchant#a1234567890"')
  keep('R12 date format', 'format("YYYY-MM-DD[T]HH:mm:ss")')
  keep('R12 quoted-printable html', '<td width=3D"100%"=20border=3D"0"=20cellpadding=3D"0">')
  keep('R12 yaml tag', 'Password: !Ref DbPassword')
}

// R16 to R23. Public ids and names that were hidden as keys.
{
  keep('R16 claude session trailer', `Claude-Session: https://claude.ai/code/${'session' + '_01' + mixed(22)}`)
  keep('R16 server tool use id', `{"tool_use_id":"${'srvtoolu' + '_01' + mixed(22)}"}`)
  keep('R16 vercel team', `GET https://api.vercel.com/v2/teams/${'team' + '_' + mixed(24)}`)
  keep('R16 vercel project', `projectId: ${'prj' + '_' + mixed(28)}`)
  keep('R17 linkedin post slug', `https://www.linkedin.com/posts/stasbel_claude-code-hooks-are-the-best-part-activity-${pick(DIGIT, 19)}-${mixed(4)}`)
  keep('R17 zoom recording', `"path": "/zoom/GMT20260807-${pick(DIGIT, 6)}_Recording.m4a"`)
  keep('R18 stripe sender address', `From: "Acme" <invoice+statements+acct_${mixed(16)}@stripe.com>`)
  keep('R19 hashed css class in style', `<style>@media (min-width:600px){.rio-card-stack-${mixed(22)} .main{height:1px}}</style>`)
  keep('R20 cloudflare beacon', `<script defer data-cf-beacon='{"version":"2025.1.0","token":"${hex(32)}"}'></script>`)
  keep('R21 hashed asset file', `<img src="https://cdn.example.org/assets/spacer-${hex(64)}.png">`)
  const ses = `${hex(46)}-${pick('ABCDEF0123456789', 14)}`
  keep('R22 ses return path', `Received-SPF: pass (google.com: domain of ${ses}@eu-west-1.amazonses.com designates 1.2.3.4 as permitted sender)\nReturn-Path: <${ses}@eu-west-1.amazonses.com>\nSubject: Your receipt`)
  keep('R23 test fixture value', 'process.env.INTERNAL_API_KEY = "test-internal-key";')
  const random = mixed(40)
  hide('R21 random name before .png is still hidden', `/tmp/${random}.png`, random)
  const prefixed = 'acme' + '_live_' + mixed(32)
  hide('R17 words then random is still hidden', `the key ${prefixed} was printed`, prefixed.slice(10))
  const numbered = 'acme_' + pick(DIGIT, 10) + '_' + mixed(14)
  hide('R17 word, number, random is still hidden', `value ${numbered} here`, numbered.slice(16))
}

// MCP tool names whose server name holds a UUID.
{
  const server = uuid()
  keep('mcp tool, uuid server', `mcp__${server}__getJiraIssue\nmcp__${server}__searchJiraIssuesUsingJql`)
  keep('mcp tool, bare uuid server', `select:mcp__${server.replaceAll('-', '')}__executeRead`)
  keep('mcp tool, snake uuid server', `"name": "mcp__${server.replaceAll('-', '_')}__get_issue"`)
  const key = mixed(32)
  hide('mcp tool, random server is still hidden', `mcp__${key}__getJiraIssue`, key)
  hide('mcp tool, random tool is still hidden', `mcp__jira__${key}`, key)
}

// --------------------------------------------------------------- the checks

let bad = 0
const fail = (msg: string): void => {
  bad++
  console.log(msg)
}

// A miss is any 8-character window of the secret that survives.
const leaks = (out: string, secret: string): boolean => {
  if (secret.length < 8) return out.includes(secret)
  for (let i = 0; i + 8 <= secret.length; i++) if (out.includes(secret.slice(i, i + 8))) return true
  return false
}

for (const [label, text, secret] of HIDE) {
  const out = label.includes('(pii)') ? scrubPii(text, piiCfg) : scrub(text)
  if (out === text || leaks(out, secret)) fail(`MISS  ${label}`)
  else if (restore(out) !== text) fail(`LOSS  ${label}: the placeholder did not give the value back`)
}
for (const [label, text] of KEEP) {
  const out = scrub(text)
  if (out !== text) fail(`FALSE POSITIVE  ${label}: ${tagCount(out)} placeholder(s)`)
}
for (const [label, text] of BLOBS) {
  const n = tagCount(scrub(text))
  if (n > 0) fail(`SHREDDED  ${label}: ${n} placeholder(s)`)
  else KEEP.push([label, text])
}

for (const text of ROUND_TRIP) {
  const label = text.slice(0, 12)
  const once = scrub(text)
  if (once === text) fail(`MISS  userinfo ${label}`)
  if (restore(once) !== text) fail(`LOSS  userinfo ${label}`)
  if (scrub(once) !== once) fail(`DRIFT  userinfo rescrub ${label}`)
}
{
  const line = `KEY=${ANTHROPIC}`
  if (scrub(line) !== scrub(line)) fail('DRIFT  the same value minted two placeholders')
  const tag = scrub(line).slice(4)
  const typed = `curl https://u:${tag}@host.io/x`
  if (scrub(typed) !== typed) fail('DRIFT  a placeholder typed into a URL was wrapped again')
  if (restore(scrub(typed)) !== `curl https://u:${ANTHROPIC}@host.io/x`) fail('LOSS  a placeholder typed into a URL')
  const param = `https://x.io/?api_key=${tag}`
  if (restore(scrub(param)) !== `https://x.io/?api_key=${ANTHROPIC}`) fail('LOSS  a placeholder in a query parameter')
}

// allowUrlHosts: the path on a listed host is kept; the query, the fragment,
// lookalike hosts and vendor-shaped keys are still hidden. Each check uses its
// own id, because a value hidden once is hidden wherever it turns up again.
{
  const urlCfg = makeConfig({ allowUrlHosts: 'app.todoist.com, https://linear.app/, localhost:3000, *.example.dev, my_host.local' })
  const slug = (): string => `check-real-user-lcp-on-mobile-${mixed(16)}`
  const probe = `https://app.todoist.com/app/task/${slug()}`
  if (scrub(probe) === probe) fail('MISS  allowUrlHosts: the default config no longer hides a task slug, so this test proves nothing')
  for (const text of [
    `https://app.todoist.com/app/task/${slug()}`,
    `see https://app.todoist.com/app/task/${slug()}.`,
    `https://linear.app/acme/issue/ENG-1/${slug()}`,
    `https://APP.todoist.com:443/app/task/${slug()}`,
    `{"url":"https:\\/\\/app.todoist.com\\/app\\/task\\/${slug()}"}`,
    `http://localhost:3000/t/${slug()}`,
    `https://eu.app.example.dev/t/${slug()}`,
    `https://my_host.local/t/${slug()}`,
  ]) {
    if (scrubSecrets(text, urlCfg) !== text) fail(`FALSE POSITIVE  allowUrlHosts: ${text}`)
  }
  // The same slug hidden elsewhere in the text is not hidden again inside the link.
  {
    const s = slug()
    const link = `https://app.todoist.com/app/task/${s}`
    if (!scrubSecrets(`{"slug":"${s}","url":"${link}"}`, urlCfg).includes(`"url":"${link}"`)) fail('MISS  allowUrlHosts: a slug repeated outside the link hid the link')
  }
  // An unnamed random value in the query or fragment, which only the token scan can catch.
  for (const tail of ['?x=', '#']) {
    const task = `https://app.todoist.com/app/task/${slug()}`
    const value = mixed(32)
    if (!leaks(scrub(`https://x.io/${tail}${value}`), value)) {
      const out = scrubSecrets(`${task}${tail}${value}`, urlCfg)
      if (leaks(out, value) || !out.startsWith(task)) fail(`MISS  allowUrlHosts: a value after ${tail} on a listed host`)
    } else fail(`MISS  allowUrlHosts: the default config keeps a value after ${tail}, so this test proves nothing`)
  }
  for (const [text, secret] of [
    ...['https://app.todoist.com.evil.io/task/', 'https://evil.io/app.todoist.com/', 'https://app.todoist.com@evil.io/', 'https://example.dev/t/', 'https://eu.app.todoist.com/t/'].map((u) => {
      const s = slug()
      return [u + s, s.slice(-16)]
    }),
    [`https://app.todoist.com/${ANTHROPIC}`, ANTHROPIC],
    // A token that starts inside the path and runs past it is judged whole.
    ...[mixed(32)].map((k) => [`https://app.todoist.com/x/ab+${k}`, k]),
  ]) {
    if (leaks(scrubSecrets(text, urlCfg), secret)) fail(`MISS  allowUrlHosts: ${text.slice(0, 40)}`)
  }
  const odd = makeConfig({ allowUrlHosts: 'app.todoist.com, not a host, *bad' }).allowUrlRejected.join('|')
  if (odd !== 'not a host|*bad') fail(`allowUrlHosts: rejected entries are ${odd}`)
}

// The two mods carry the same detector and the same tests. When both sit in
// this repo, the copies must match, or a fix lands in only one of them.
{
  const { existsSync, readFileSync } = await import('node:fs')
  const root = new URL('../../', import.meta.url)
  const pairs = [
    ['secret-box/hooks/detect.ts', 'transcript-redactor/hooks/detect.ts'],
    ['secret-box/tests/detect.test.mts', 'transcript-redactor/test/detect.test.mts'],
  ]
  for (const [x, y] of pairs) {
    const [fx, fy] = [new URL(x!, root), new URL(y!, root)]
    if (existsSync(fx) && existsSync(fy) && readFileSync(fx, 'utf8') !== readFileSync(fy, 'utf8')) fail(`COPY  ${x} and ${y} differ`)
  }
}

// 25. A live placeholder read back from a file is quoted text, not a handle.
{
  const tag = scrub(`k=${GITHUB}`).slice(2)
  const file = `README says: TOKEN=${tag}`
  const shown = scrub(escapeLiteralTags(file))
  if (shown.includes(tag)) fail('LITERAL  a live placeholder in a file stayed live')
  if (restore(shown) !== file) fail('LITERAL  a quoted placeholder did not restore to its own text')
  if (restore(shown).includes(GITHUB)) fail('LITERAL  a quoted placeholder restored to the secret')
  if (escapeLiteralTags(shown) !== shown) fail('LITERAL  escaping is not idempotent')
  const echoed = scrub(escapeLiteralTags(`echo ${GITHUB}`))
  if (!echoed.includes(tag)) fail('LITERAL  an echoed key did not come back as its live placeholder')
  const unknown = '[REDACTED-SECRET-' + '0'.repeat(8) + ']'
  if (escapeLiteralTags(unknown) !== unknown) fail('LITERAL  an unknown placeholder was touched')
}

// 44. A value hidden once because of its context is hidden again bare.
{
  const h = lowerDigit(12)
  const first = scrub(`DB_PASSWORD=${h}`)
  const later = scrub(`echo printed ${h} back`)
  if (later.includes(h) || !later.includes(first.slice(12))) fail('ECHO  a restored value printed bare was not hidden again')
  scrub('postgres://postgres:postgres@localhost/db')
  const ps = 'docker ps: postgres:16 postgres-main'
  if (scrub(ps) !== ps) fail('ECHO  a common word was hidden everywhere')
}

// 42. The walker scans `data` keys and deep values, and leaves media alone.
{
  const key = `${sk}-${mixed(40)}`
  const walked = walk({ docs: [{ id: 1, data: { body: `token: ${key}` } }], data: `token: ${key}` }, scrub)
  if (JSON.stringify(walked).includes(key)) fail('WALK  a key under a data key was not scanned')
  const media = { file: { base64: randomB64(5000) }, resource: { blob: randomB64(5000) } }
  if (JSON.stringify(walk(media, scrub)) !== JSON.stringify(media)) fail('WALK  media was rewritten')
  let deep: Record<string, unknown> = { text: `token: ${key}` }
  for (let i = 0; i < 20; i++) deep = { next: deep }
  if (JSON.stringify(walk(deep, scrub)).includes(key)) fail('WALK  a key 20 levels deep was not scanned')
  const st = { incomplete: false }
  walk({ when: new Date(0), map: new Map() }, scrub, st)
  if (!st.incomplete) fail('WALK  a value it cannot rewrite was not reported')
}

// R8. A base64url body under a media key that decodes to text holding a
// key is scanned and hidden whole; real media is still passed through.
{
  const body = `Hi,\n\nYour live secret key is ${sk}_live_${mixed(99)}\nKeep it safe.\n`
  const data = b64url(body)
  const walked = JSON.stringify(walk({ payload: { mimeType: 'text/plain', body: { size: body.length, data } } }, scrub))
  if (walked.includes(data.slice(0, 40)) || !TAG.test(walked)) fail('R8  a gmail body.data holding a key was passed through')
  TAG.lastIndex = 0
  const plain = b64url('Hello, your order has shipped. '.repeat(20))
  const kept = walk({ body: { data: plain } }, scrub)
  if (JSON.stringify(kept).includes('[REDACTED-')) fail('R8  a plain gmail body was rewritten')
  const png = '\x89PNG\r\n\x1a\n' + String.fromCharCode(...Array.from({ length: 600 }, () => Math.floor(rand() * 256)))
  const media = { data: b64(png) }
  if (JSON.stringify(walk(media, scrub)) !== JSON.stringify(media)) fail('R8  a png under data was rewritten')
}

// 23, 36, 45. Two values never share a placeholder, and the placeholder is
// keyed: it is not the plain hash of the value. Letters-only values keep the
// echo index small while the vault fills.
{
  const fnv = (text: string): string => {
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
    return h.toString(16).padStart(8, '0')
  }
  const byTag = new Map<string, string>()
  let unkeyed = 0
  for (let i = 0; i < 120_000; i++) {
    const v = pick(LOWER, 14)
    const t = mint('SECRET', v)
    const seen = byTag.get(t)
    if (seen !== undefined && seen !== v) {
      fail('CLASH  two values share one placeholder')
      break
    }
    byTag.set(t, v)
    if (t.slice(-9, -1) === fnv(v)) unkeyed++
  }
  for (const [t, v] of byTag) {
    if (restore(t) !== v) {
      fail('CLASH  a placeholder restored to the wrong value')
      break
    }
  }
  if (unkeyed > 2) fail('KEY  placeholders are the plain hash of their values')
}

// 38, 39, 46. Timing: realistic text and the auditors' adversarial inputs,
// 8 MB each, must finish well inside the hook's 10 s budget.
{
  const SIZE = 8_000_000
  const LIMIT_MS = 5_000
  const fill = (unit: () => string): string => {
    const parts: string[] = []
    let n = 0
    while (n < SIZE) {
      const s = unit()
      parts.push(s)
      n += s.length
    }
    return parts.join('').slice(0, SIZE)
  }
  let row = 0
  const json = (): string => Buffer.from(JSON.stringify({ id: row++, name: 'item', ok: true })).toString('base64url')
  const cases: [string, () => string, boolean][] = [
    ['logs', () => fill(() => `2026-10-12T10:11:12Z INFO id=${hex(8)} path=/api/v2/users/${row++} status=200 commit ${hex(40)}\n`), false],
    ['minified js', () => fill(() => `function ${pick(LOWER, 2)}(e,t){return e&&t?e.map(function(n){return n.${pick(LOWER, 6)}+t.length}):null}var q="${mixed(12)}";`), false],
    ['base64 one line', () => randomB64(SIZE * 0.75), false],
    ['base64url json', () => fill(json), false],
    ['eyJ repeated', () => 'eyJ'.repeat(SIZE / 3), false],
    ['sk- repeated', () => (sk + '-').repeat(SIZE / 3), false],
    ['BEGIN without END', () => (PEM_BEGIN('RSA') + '\n').repeat(SIZE / 32), false],
    ['password lines', () => fill(() => `password: ${mixed(10)}\n`), false],
    ['one url parameter', () => 'https://x.io/?token=' + pick(B62 + '%', 400_000).repeat(20), false],
    ['local part, no @ (pii)', () => 'abcdefghij.'.repeat(SIZE / 11), true],
    ['a@a1. (pii)', () => 'a@' + 'a1.'.repeat(SIZE / 3), true],
  ]
  for (const [label, make, pii] of cases) {
    const text = make()
    const t0 = performance.now()
    let err = ''
    try {
      if (pii) scrubPii(text, piiCfg)
      else scrub(text)
    } catch (e) {
      err = (e as Error).message
    }
    const ms = Math.round(performance.now() - t0)
    console.log(`time  ${label.padEnd(24)} ${(text.length / 1e6).toFixed(1)} MB  ${ms} ms`)
    if (err) fail(`THROW  ${label}: ${err}`)
    if (ms > LIMIT_MS) fail(`SLOW  ${label}: ${ms} ms`)
  }
}

console.log(bad === 0 ? `ok  ${HIDE.length} hidden, ${KEEP.length} kept, round trip clean` : `${bad} failure(s)`)
if (bad > 0) process.exitCode = 1
