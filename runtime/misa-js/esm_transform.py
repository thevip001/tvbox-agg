"""Python port of MisaTV's deliberately small regex ESM -> CommonJS transformer."""
import json, re

IDENT = r'[A-Za-z_$\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*'
HAS_MODULE = re.compile(r'(^|[\n;])\s*(import|export)\b')
IMPORT_DEFAULT_NAMED = re.compile(r'import\s+('+IDENT+r')\s*,\s*\{([\s\S]*?)\}\s*from\s*[\'"]([^\'"]+)[\'"]\s*;?')
IMPORT_NS = re.compile(r'import\s*\*\s*as\s+('+IDENT+r')\s+from\s*[\'"]([^\'"]+)[\'"]\s*;?')
IMPORT_NAMED = re.compile(r'import\s*\{([\s\S]*?)\}\s*from\s*[\'"]([^\'"]+)[\'"]\s*;?')
IMPORT_DEFAULT = re.compile(r'import\s+('+IDENT+r')\s+from\s*[\'"]([^\'"]+)[\'"]\s*;?')
EXPORT_FUNC = re.compile(r'export\s+(async\s+)?function\s+('+IDENT+r')')
EXPORT_VAR = re.compile(r'export\s+(const|let|var)\s+('+IDENT+r')')
EXPORT_DEFAULT = re.compile(r'export\s+default\s*')
EXPORT_FROM = re.compile(r'export\s*\{([\s\S]*?)\}\s*from\s*[\'"]([^\'"]+)[\'"]\s*;?')
EXPORT_LOCAL = re.compile(r'export\s*\{([\s\S]*?)\}\s*;?')
IMPORT_SIDE = re.compile(r'import\s*[\'"]([^\'"]+)[\'"]\s*;?')
SPEC = re.compile(r'^('+IDENT+r')(?:\s+as\s+('+IDENT+r'))?$')

class ESMTransformError(Exception): pass

def q(value): return json.dumps(value, ensure_ascii=False)

def split_specs(raw):
    out=[]
    for piece in raw.split(','):
        m=SPEC.match(piece.strip())
        if m: out.append((m.group(1),m.group(2) or m.group(1)))
    return out

def transform_to_cjs(source, module_name=''):
    if not HAS_MODULE.search(source) and 'export default' not in source:
        return source
    code=source
    tail=[]
    seq=[0]
    def reexport(m):
        names,spec=m.group(1),m.group(2)
        tmp='_m'+str(seq[0]); seq[0]+=1
        lines=[f'const {tmp} = require({q(spec)});']
        for prop,name in split_specs(names):
            lines.append(f'module.exports[{q(name)}] = {tmp}[{q(prop)}];')
        return '\n'.join(lines)
    code=EXPORT_FROM.sub(reexport,code)
    if re.search(r'export\s*\*\s*from',code):
        raise ESMTransformError('unsupported export * from: '+module_name)
    def default_named(m):
        default,names,spec=m.group(1),m.group(2),m.group(3)
        tmp='_m'+str(seq[0]); seq[0]+=1
        lines=[f'const {tmp} = require({q(spec)});',f'const {default} = {tmp} != null && {tmp}.default !== undefined ? {tmp}.default : {tmp};']
        for prop,name in split_specs(names): lines.append(f'const {name} = {tmp}[{q(prop)}];')
        return '\n'.join(lines)
    code=IMPORT_DEFAULT_NAMED.sub(default_named,code)
    code=IMPORT_NS.sub(lambda m:f'const {m.group(1)} = require({q(m.group(2))});',code)
    def named(m):
        names,spec=m.group(1),m.group(2)
        tmp='_m'+str(seq[0]); seq[0]+=1
        lines=[f'const {tmp} = require({q(spec)});']
        for prop,name in split_specs(names): lines.append(f'const {name} = {tmp}[{q(prop)}];')
        return '\n'.join(lines)
    code=IMPORT_NAMED.sub(named,code)
    def default(m):
        name,spec=m.group(1),m.group(2)
        tmp='_m'+str(seq[0]); seq[0]+=1
        return f'const {tmp} = require({q(spec)});\nconst {name} = {tmp} != null && {tmp}.default !== undefined ? {tmp}.default : {tmp};'
    code=IMPORT_DEFAULT.sub(default,code)
    code=IMPORT_SIDE.sub(lambda m:f'require({q(m.group(1))});',code)
    code=EXPORT_DEFAULT.sub('module.exports.default = ',code)
    def exp_func(m):
        name=m.group(2); tail.append(f'module.exports[{q(name)}] = {name};')
        return (m.group(1) or '')+'function '+name
    code=EXPORT_FUNC.sub(exp_func,code)
    def exp_var(m):
        kw,name=m.group(1),m.group(2); tail.append(f'module.exports[{q(name)}] = {name};')
        return kw+' '+name
    code=EXPORT_VAR.sub(exp_var,code)
    def exp_local(m):
        for prop,name in split_specs(m.group(1)): tail.append(f'module.exports[{q(name)}] = {prop};')
        return ''
    code=EXPORT_LOCAL.sub(exp_local,code)
    return code+'\n'+'\n'.join(tail) if tail else code
