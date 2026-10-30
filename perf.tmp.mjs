import fs from 'fs'
const src = fs.readFileSync('plugins/secret-box/hooks/register.jsx','utf8')
const body = src.slice(src.indexOf('const ARG ='), src.indexOf('\n}\n', src.indexOf('function gitRuns'))+3)
const gitRuns = new Function(body + '; return gitRuns')()
for (const c of ['env ' + '-a b '.repeat(3000) + 'x', 'sudo ' + '-u bob '.repeat(3000) + 'echo', 'A=1 '.repeat(5000)+'ls', 'time '.repeat(5000)+'ls', ('x=1; ').repeat(3000) + 'echo commit', 'git '.repeat(3000)+'log', 'env -- '.repeat(2000)+'ls']) {
  const t=Date.now(); const r=gitRuns(c,'commit'); console.log(r, Date.now()-t+'ms', c.length)
}
