# =============================================================================
# yardmaster Tiltfile — ships with the CLI and reads the workspace's
# services.yaml (YM_ROOT, exported by `ym up`). Edit services.yaml, not this.
# =============================================================================

config.define_string_list('only', usage='restrict to a subset of services')
cfg = config.parse()
only = cfg.get('only', [])

IS_WINDOWS = os.name == "nt"
ROOT = os.getenv('YM_ROOT', os.getcwd())
LOCAL = os.path.join(ROOT, '.ym')

# argv lists, not strings, so workspace paths with spaces survive.
if IS_WINDOWS:
    nginx_cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', os.path.join(LOCAL, 'nginx', 'start-nginx.ps1')]
else:
    nginx_cmd = ['bash', os.path.join(LOCAL, 'nginx', 'start-nginx.sh')]

spec = read_yaml(os.path.join(ROOT, 'services.yaml'))
defaults = spec.get('defaults', {}) or {}
services = spec.get('services', []) or []

print("yardmaster: %d service(s) declared" % len(services))

def short_name(svc):
    return svc.get('display_name', svc['name'])

names = {s['name']: short_name(s) for s in services}

local_resource(
    name="nginx",
    serve_cmd=nginx_cmd,
    serve_dir=ROOT,
    deps=[os.path.join(LOCAL, 'nginx', 'conf', 'nginx.conf')],
    auto_init=True,
    trigger_mode=TRIGGER_MODE_MANUAL,
)

def register(svc):
    name = svc['name']
    # `source:` lets sidecars reuse another service's repo dir.
    sdir = os.path.join(ROOT, svc.get('source', name))
    serve_cmd = svc.get('serve_cmd', defaults.get('serve_cmd', 'node .'))

    watch = svc.get('watch')
    deps = [os.path.join(sdir, w) for w in watch] if watch else [sdir]

    extra_env = {
        'FORCE_COLOR': '1',
        'LOG_LEVEL': svc.get('log_level', defaults.get('log_level', 'debug')),
    }
    if svc.get('port') != None:
        extra_env['PORT'] = str(svc['port'])
    for k, v in (svc.get('env') or {}).items():
        extra_env[k] = str(v)

    local_resource(
        name=short_name(svc),
        serve_cmd=serve_cmd,
        serve_dir=sdir,
        deps=deps,
        serve_env=extra_env,
        resource_deps=[names.get(d, d) for d in (svc.get('depends_on') or [])],
        auto_init=True,
    )

only_set = {n: True for n in only}
for svc in services:
    if len(only) > 0 and svc['name'] not in only_set:
        continue
    register(svc)
