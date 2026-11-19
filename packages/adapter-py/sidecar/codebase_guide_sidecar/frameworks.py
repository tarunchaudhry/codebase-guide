"""Python framework adapters: Django (+DRF), FastAPI, Flask, SQLAlchemy, Pydantic.

`collect(fx)` runs per file during pass 2 and returns JSON *facts* (cached with the fragment).
Values are encoded generically (`val`): str/int/bool/None/list as-is, {"ref": dotted}, {"local": name},
{"call": dotted|None, "args": [...], "kw": {...}}, {"concat": [...]}, {"sub": v, "index": v}, {"expr": text}.
`enrich(...)` runs once over all facts with the global resolver — no AST — and builds framework nodes/edges/patches.
"""
from __future__ import annotations

import ast
import posixpath
import re
from typing import Any, Dict, List, Optional, Set, Tuple

HTTP = ["get", "post", "put", "patch", "delete", "head", "options"]
INTEREST_CALLS = {"include_router", "register_blueprint", "register", "add_middleware", "add_url_rule",
                  "before_request", "after_request", "connect"}
FACTORIES = {
    "fastapi.FastAPI": ("fastapi", "app"), "fastapi.applications.FastAPI": ("fastapi", "app"),
    "fastapi.APIRouter": ("fastapi", "router"), "fastapi.routing.APIRouter": ("fastapi", "router"),
    "flask.Flask": ("flask", "app"), "flask.app.Flask": ("flask", "app"),
    "flask.Blueprint": ("flask", "blueprint"), "flask.blueprints.Blueprint": ("flask", "blueprint"),
    "rest_framework.routers.DefaultRouter": ("drf", "router"), "rest_framework.routers.SimpleRouter": ("drf", "router"),
}
DJANGO_MODEL = {"django.db.models.Model", "django.db.models.base.Model"}
SQLA_BASES = {"sqlalchemy.orm.DeclarativeBase", "sqlalchemy.orm.DeclarativeBaseNoMeta", "sqlalchemy.orm.decl_api.DeclarativeBase"}
SQLA_BASE_FACTORIES = {"sqlalchemy.orm.declarative_base", "sqlalchemy.ext.declarative.declarative_base", "sqlalchemy.orm.decl_api.declarative_base"}
FLASK_SQLA = {"flask_sqlalchemy.SQLAlchemy"}
PYDANTIC = {"pydantic.BaseModel", "pydantic.main.BaseModel"}
SETTINGS = {"pydantic.BaseSettings", "pydantic_settings.BaseSettings"}
DJANGO_WRITES = {"create", "update", "delete", "bulk_create", "bulk_update", "get_or_create", "update_or_create", "save"}
SQLA_CORE = {"select": False, "update": True, "delete": True, "insert": True}
GENERIC_VIEW_METHODS = {
    "View": [], "TemplateView": ["GET"], "RedirectView": ["GET"], "ListView": ["GET"], "DetailView": ["GET"],
    "CreateView": ["GET", "POST"], "UpdateView": ["GET", "POST"], "DeleteView": ["GET", "POST"], "FormView": ["GET", "POST"],
    "APIView": [], "GenericAPIView": [], "ListAPIView": ["GET"], "RetrieveAPIView": ["GET"], "CreateAPIView": ["POST"],
    "DestroyAPIView": ["DELETE"], "UpdateAPIView": ["PUT", "PATCH"], "ListCreateAPIView": ["GET", "POST"],
    "RetrieveUpdateAPIView": ["GET", "PUT", "PATCH"], "RetrieveDestroyAPIView": ["GET", "DELETE"],
    "RetrieveUpdateDestroyAPIView": ["GET", "PUT", "PATCH", "DELETE"], "MethodView": [],
}
VIEWSET_ACTIONS = {
    "ModelViewSet": ["list", "create", "retrieve", "update", "partial_update", "destroy"],
    "ReadOnlyModelViewSet": ["list", "retrieve"],
    "ListModelMixin": ["list"], "CreateModelMixin": ["create"], "RetrieveModelMixin": ["retrieve"],
    "UpdateModelMixin": ["update", "partial_update"], "DestroyModelMixin": ["destroy"],
}
ACTION_ROUTES = {"list": ("GET", False), "create": ("POST", False), "retrieve": ("GET", True),
                 "update": ("PUT", True), "partial_update": ("PATCH", True), "destroy": ("DELETE", True)}


# ================================================================ per-file facts

def val(n: Optional[ast.AST], fx: Any, scope: Tuple[Dict[str, str], Set[str]], depth: int = 0) -> Any:
    from .extract import dotted_of, one_line
    if n is None:
        return None
    if depth > 8:
        return {"expr": "…"}
    if isinstance(n, ast.Constant):
        return n.value if isinstance(n.value, (str, int, float, bool)) or n.value is None else {"expr": one_line(repr(n.value), 80)}
    if isinstance(n, (ast.List, ast.Tuple, ast.Set)):
        return [val(e, fx, scope, depth + 1) for e in n.elts]
    if isinstance(n, ast.Dict):
        return {"dict": [[val(k, fx, scope, depth + 1), val(v, fx, scope, depth + 1)] for k, v in zip(n.keys, n.values)]}
    if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
        return {"concat": [val(n.left, fx, scope, depth + 1), val(n.right, fx, scope, depth + 1)]}
    parts = dotted_of(n)
    if parts:
        q = fx.qualify(parts, scope)
        return {"ref": q} if q else {"local": ".".join(parts)}
    if isinstance(n, ast.Call):
        fparts = dotted_of(n.func)
        out: Dict[str, Any] = {"call": None, "args": [val(a, fx, scope, depth + 1) for a in n.args],
                               "kw": {k.arg: val(k.value, fx, scope, depth + 1) for k in n.keywords if k.arg}, "line": n.lineno}
        if fparts:
            q = fx.qualify(fparts, scope)
            out["call"] = q if q else "local:" + ".".join(fparts)
        elif isinstance(n.func, ast.Attribute):
            out["method"] = n.func.attr
            out["on"] = val(n.func.value, fx, scope, depth + 1)
        return out
    if isinstance(n, ast.Subscript):
        sl = n.slice
        if type(sl).__name__ == "Index":  # Python 3.8 wrapper
            sl = sl.value  # type: ignore[attr-defined]
        return {"sub": val(n.value, fx, scope, depth + 1), "index": val(sl, fx, scope, depth + 1)}
    return {"expr": one_line(ast.unparse(n), 120)}


def chain_names(e: ast.AST) -> Optional[List[str]]:
    """User.objects.filter(x).update() → ['User', 'objects', 'filter', 'update']."""
    names: List[str] = []
    while True:
        if isinstance(e, ast.Call):
            e = e.func
        elif isinstance(e, ast.Attribute):
            names.append(e.attr)
            e = e.value
        elif isinstance(e, ast.Name):
            names.append(e.id)
            return names[::-1]
        else:
            return None


HTTP_CLIENT_FACTORIES = {"requests.Session", "requests.sessions.Session", "httpx.Client", "httpx.AsyncClient"}
HTTP_MODULE_CALL = re.compile(r"^(requests|httpx)\.(get|post|put|patch|delete|head|options)$")


def py_url(n: Optional[ast.AST], consts: Dict[str, str], depth: int = 0) -> Optional[Tuple[str, bool]]:
    """URL expression → (template with {param} holes, dynamic base?) or None when fully dynamic."""
    if n is None or depth > 4:
        return None
    if isinstance(n, ast.Constant) and isinstance(n.value, str):
        return n.value, False
    if isinstance(n, ast.Name):
        return (consts[n.id], False) if n.id in consts else None
    parts: List[Optional[str]] = []
    if isinstance(n, ast.JoinedStr):
        for v in n.values:
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                parts.append(v.value)
            else:
                inner = py_url(getattr(v, "value", None), consts, depth + 1)
                parts.append(inner[0] if inner and not inner[1] else None)
    elif isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
        flat: List[ast.AST] = []

        def walk(x: ast.AST) -> None:
            if isinstance(x, ast.BinOp) and isinstance(x.op, ast.Add):
                walk(x.left)
                walk(x.right)
            else:
                flat.append(x)
        walk(n)
        for piece in flat:
            r = py_url(piece, consts, depth + 1)
            parts.append(r[0] if r and not r[1] else None)
    elif isinstance(n, ast.Call) and isinstance(n.func, (ast.Name, ast.Attribute)) and (getattr(n.func, "id", None) or getattr(n.func, "attr", None)) == "urljoin" and len(n.args) == 2:
        r = py_url(n.args[1], consts, depth + 1)
        return (r[0], True) if r else None
    else:
        return None
    dynamic = False
    while parts and (parts[0] is None or parts[0] == ""):
        dynamic = dynamic or parts[0] is None
        parts.pop(0)
    url = "".join("{param}" if p is None else p for p in parts)
    if not url or url == "{param}" or (dynamic and not url.startswith("/")):
        return None
    return url, dynamic


def collect(fx: Any) -> Optional[Dict[str, Any]]:
    from .extract import dotted_of, top_level_statements
    facts: Dict[str, Any] = {}
    empty: Tuple[Dict[str, str], Set[str]] = ({}, set())

    def add(key: str, item: Any) -> None:
        facts.setdefault(key, []).append(item)

    # module-level assignments (settings values, factories, urlpatterns)
    assigns: Dict[str, List[Any]] = {}
    for st, _ in top_level_statements(fx.tree.body):
        if isinstance(st, ast.Assign):
            for t in st.targets:
                if isinstance(t, ast.Name):
                    assigns.setdefault(t.id, []).append(["=", val(st.value, fx, empty), st.lineno])
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.value is not None:
            assigns.setdefault(st.target.id, []).append(["=", val(st.value, fx, empty), st.lineno])
        elif isinstance(st, ast.AugAssign) and isinstance(st.target, ast.Name) and isinstance(st.op, ast.Add):
            assigns.setdefault(st.target.id, []).append(["+=", val(st.value, fx, empty), st.lineno])
    if assigns:
        facts["assigns"] = assigns

    # classes
    for st, nid, cls in fx.def_ids:
        if not isinstance(st, ast.ClassDef):
            continue
        cf: Dict[str, Any] = {"id": nid, "name": st.name, "line": st.lineno, "bases": [val(b, fx, empty) for b in st.bases],
                              "attrs": {}, "meta": {}, "fields": [], "methods": [], "kw": {k.arg: val(k.value, fx, empty) for k in st.keywords if k.arg}}
        for sub in st.body:
            if isinstance(sub, ast.Assign) and len(sub.targets) == 1 and isinstance(sub.targets[0], ast.Name):
                name = sub.targets[0].id
                v = val(sub.value, fx, empty)
                cf["attrs"][name] = v
                if isinstance(sub.value, ast.Call):
                    cf["fields"].append({"name": name, "value": v, "line": sub.lineno})
            elif isinstance(sub, ast.AnnAssign) and isinstance(sub.target, ast.Name):
                v = val(sub.value, fx, empty) if sub.value is not None else None
                cf["fields"].append({"name": sub.target.id, "ann": ast.unparse(sub.annotation), "annv": val(sub.annotation, fx, empty), "value": v, "line": sub.lineno})
                if v is not None:
                    cf["attrs"][sub.target.id] = v
            elif isinstance(sub, ast.ClassDef) and sub.name in ("Meta", "Config"):
                for s in sub.body:
                    if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name):
                        cf["meta"][s.targets[0].id] = val(s.value, fx, empty)
            elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                cf["methods"].append({"name": sub.name, "line": sub.lineno, "decorators": [val(d, fx, empty) for d in sub.decorator_list]})
        add("classes", cf)

    # functions (top-level + methods): decorators and parameters (for Depends / Annotated / body models)
    for st, nid, cls in fx.def_ids:
        if isinstance(st, ast.ClassDef):
            continue
        scope = fx.scopes.get(id(st), empty)
        a = st.args
        params = []
        positional = list(a.posonlyargs) + list(a.args)
        defaults = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
        for arg, d in list(zip(positional, defaults)) + list(zip(a.kwonlyargs, a.kw_defaults)):
            if arg.arg in ("self", "cls"):
                continue
            params.append({"name": arg.arg, "ann": val(arg.annotation, fx, empty) if arg.annotation is not None else None,
                           "default": val(d, fx, empty) if d is not None else None})
        decos = [val(d, fx, empty) for d in st.decorator_list]
        if decos or any(p["ann"] is not None or p["default"] is not None for p in params):
            add("functions", {"id": nid, "line": st.lineno, "decorators": decos, "params": params,
                              "returns": val(st.returns, fx, empty) if st.returns is not None else None})

    # calls of interest, local factory assignments, ORM chains — module level, functions, class bodies
    scopes: List[Tuple[ast.AST, str, Tuple[Dict[str, str], Set[str]]]] = []
    for st, nid, cls in fx.def_ids:
        if not isinstance(st, ast.ClassDef):
            scopes.append((st, nid, fx.scopes.get(id(st), empty)))
    for st, _ in top_level_statements(fx.tree.body):
        if not isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.If, ast.Try, ast.With)):
            scopes.append((st, fx.mod_id, empty))
    for st, nid, cls in fx.def_ids:
        if isinstance(st, ast.ClassDef):
            for sub in st.body:
                if not isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    scopes.append((sub, nid, empty))
    consts = {k: v[-1][1] for k, v in assigns.items() if v[-1][0] == "=" and isinstance(v[-1][1], str)}
    module_clients = {k: v[-1][1] for k, v in assigns.items() if isinstance(v[-1][1], dict) and v[-1][1].get("call") in HTTP_CLIENT_FACTORIES}
    api_clients = set(getattr(fx, "api_clients", []) or [])

    def http(n: ast.Call, src: str, scope, clients: Dict[str, Any]) -> None:
        fparts = dotted_of(n.func)
        if not fparts:
            return
        q = fx.qualify(fparts, scope) or ""
        method: Optional[str] = None
        url_node: Optional[ast.AST] = None
        base: Optional[Tuple[str, bool]] = None
        client = None
        kw = {k.arg: k.value for k in n.keywords if k.arg}
        m = HTTP_MODULE_CALL.match(q)
        if m:
            client, method, url_node = m.group(1), m.group(2).upper(), n.args[0] if n.args else kw.get("url")
        elif q in ("requests.request", "httpx.request") or (len(fparts) == 2 and fparts[0] in clients and fparts[1] == "request"):
            client = fparts[0] if q not in ("requests.request", "httpx.request") else q.split(".")[0]
            mv = n.args[0] if n.args else kw.get("method")
            method = mv.value.upper() if isinstance(mv, ast.Constant) and isinstance(mv.value, str) else None
            url_node = n.args[1] if len(n.args) > 1 else kw.get("url")
        elif len(fparts) == 2 and fparts[0] in clients and fparts[1] in HTTP:
            client, method, url_node = fparts[0], fparts[1].upper(), n.args[0] if n.args else kw.get("url")
        elif ".".join(fparts) in api_clients or (len(fparts) >= 2 and ".".join(fparts[:-1]) in api_clients and fparts[-1] in HTTP):
            client = ".".join(fparts)
            method = fparts[-1].upper() if fparts[-1] in HTTP else None
            url_node = n.args[0] if n.args else kw.get("url")
        else:
            return
        if client in clients:
            b = clients[client]
            bu = b.get("kw", {}).get("base_url") if isinstance(b, dict) else None
            base = (bu, False) if isinstance(bu, str) else ("", True) if bu is not None else None
        u = py_url(url_node, consts)
        if u and base:
            u = (base[0].rstrip("/") + ("" if u[0].startswith("/") or not base[0] else "/") + u[0], base[1] or u[1])
        add("http", {"src": src, "client": client, "method": method, "url": u[0] if u else None, **({"dynamicBase": True} if u and u[1] else {}), "line": n.lineno})

    for node, src, scope in scopes:
        clients = dict(module_clients)
        for n in ast.walk(node):
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Call):
                v = val(n.value, fx, scope)
                if isinstance(v, dict) and v.get("call") in HTTP_CLIENT_FACTORIES:
                    clients[n.targets[0].id] = v
            elif isinstance(n, (ast.With, ast.AsyncWith)):
                for it in n.items:
                    if isinstance(it.optional_vars, ast.Name) and isinstance(it.context_expr, ast.Call):
                        v = val(it.context_expr, fx, scope)
                        if isinstance(v, dict) and v.get("call") in HTTP_CLIENT_FACTORIES:
                            clients[it.optional_vars.id] = v
        for n in ast.walk(node):
            if isinstance(n, ast.Call) and not (node is not n and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
                http(n, src, scope, clients)
        inner: Set[int] = set()
        for n in ast.walk(node):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Call):
                inner.add(id(n.func.value))
        for n in ast.walk(node):
            if node is not n and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and src == fx.mod_id:
                continue
            if isinstance(n, ast.Assign) and src != fx.mod_id and isinstance(n.value, ast.Call) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                v = val(n.value, fx, scope)
                if isinstance(v, dict) and v.get("call") in FACTORIES:
                    add("local_assigns", {"name": n.targets[0].id, "value": v, "line": n.lineno})
            if not isinstance(n, ast.Call):
                continue
            if isinstance(n.func, ast.Attribute) and n.func.attr in INTEREST_CALLS:
                add("calls", {"src": src, **val(n, fx, scope)})
            names = chain_names(n) if id(n) not in inner else None  # manager chains: only the outermost call
            if names and len(names) >= 3:
                for mgr in ("objects", "query"):
                    if mgr in names[1:]:
                        i = names.index(mgr, 1)
                        q = fx.qualify(names[:i], scope)
                        if q:
                            add("orm", {"src": src, "model": q, "via": mgr, "ops": names[i + 1:], "line": n.lineno})
                        break
            fparts = dotted_of(n.func)
            last = fparts[-1] if fparts else (n.func.attr if isinstance(n.func, ast.Attribute) else None)
            arg0 = n.args[0] if n.args else None
            if last in SQLA_CORE and fparts and (fx.qualify(fparts, scope) or "").startswith("sqlalchemy.") and arg0 is not None and dotted_of(arg0):
                q = fx.qualify(dotted_of(arg0), scope)
                if q:
                    add("orm", {"src": src, "model": q, "via": "sqla-core", "ops": [last], "line": n.lineno})
            elif last in ("query", "get", "scalars", "execute") and isinstance(n.func, ast.Attribute) and arg0 is not None and dotted_of(arg0):
                q = fx.qualify(dotted_of(arg0), scope)
                if q:
                    add("orm", {"src": src, "model": q, "via": "session", "ops": [last], "line": n.lineno})
            elif last in ("add", "add_all", "merge") and isinstance(n.func, ast.Attribute) and isinstance(arg0, ast.Call) and dotted_of(arg0.func):
                q = fx.qualify(dotted_of(arg0.func), scope)
                if q:
                    add("orm", {"src": src, "model": q, "via": "session", "ops": [last], "line": n.lineno})
            elif fparts and (fx.qualify(fparts, scope) or "") in ("django.shortcuts.get_object_or_404", "django.shortcuts.get_list_or_404") and arg0 is not None and dotted_of(arg0):
                q = fx.qualify(dotted_of(arg0), scope)
                if q:
                    add("orm", {"src": src, "model": q, "via": "objects", "ops": ["get"], "line": n.lineno})
    if fx.env_defaults:
        facts["env_defaults"] = fx.env_defaults
    return facts or None


# ================================================================ global pass

def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


class Enricher:
    def __init__(self, projects, fragments, res, files, config):
        self.projects, self.fragments, self.res, self.files, self.config = projects, fragments, res, set(files), config
        self.nodes: List[Dict[str, Any]] = []
        self.edges: Dict[str, Dict[str, Any]] = {}
        self.warnings: Dict[str, Dict[str, Any]] = {}
        self.stats: Dict[str, int] = {}
        self.patches: Dict[str, Dict[str, Any]] = {}
        self.evidence: Dict[str, Set[str]] = {}
        self.facts = {f: fr.get("facts") or {} for f, fr in fragments.items()}
        self.node_by_id = {n["id"]: n for fr in fragments.values() for n in fr["nodes"]}
        self.classes: Dict[str, Dict[str, Any]] = {}
        for f, ff in sorted(self.facts.items()):
            for c in ff.get("classes", []):
                self.classes[c["id"]] = {**c, "file": f}
        self.functions = {fn["id"]: {**fn, "file": f} for f, ff in sorted(self.facts.items()) for fn in ff.get("functions", [])}
        self.endpoint_ids: Dict[str, int] = {}
        self._anc: Dict[str, Tuple[List[str], Set[str]]] = {}

    # -- output helpers
    def bump(self, k: str, n: int = 1) -> None:
        self.stats[k] = self.stats.get(k, 0) + n

    def warn(self, code: str, msg: str, path: Optional[str] = None) -> None:
        w = self.warnings.setdefault(code, {"code": code, "message": msg, "count": 0, "paths": []})
        w["count"] += 1
        if path:
            w["paths"].append(path)

    def edge(self, kind: str, src: str, dst: str, path: str, line: int, inferred: bool = False, meta: Optional[Dict[str, Any]] = None) -> None:
        if src == dst:
            return
        eid = f"{kind}:{src}->{dst}"
        e = self.edges.get(eid)
        ev = {"path": path, "line": line}
        if e is None:
            e = {"id": eid, "source": src, "target": dst, "kind": kind, "weight": 0, "evidence": []}
            if inferred:
                e["inferred"] = True
            if meta:
                e["meta"] = meta
            self.edges[eid] = e
        elif not inferred:
            e.pop("inferred", None)
        e["weight"] += 1
        if ev not in e["evidence"]:
            e["evidence"] = sorted(e["evidence"] + [ev], key=lambda x: (x["path"], x["line"]))[:5]

    def patch(self, nid: str, **meta: Any) -> None:
        self.patches.setdefault(nid, {}).update(meta)

    def saw(self, path: Optional[str], fw: str) -> None:
        if not path:
            return
        root = next((p["root"] for p in sorted(self.projects, key=lambda p: -len(p["root"])) if p["root"] == "." or path.startswith(p["root"] + "/")), None)
        if root is not None:
            self.evidence.setdefault(root, set()).add(fw)

    # -- resolution
    def locate(self, dotted: str, hops: int = 0) -> Tuple:
        """→ ('node', id, tail) | ('var', rel, name, tail) | ('module', rel, tail) | ('external', dotted) | ('unresolved',)."""
        from .extract import node_id, exported_names
        if hops > 12:
            return ("unresolved",)
        rel, rest = self.res.module_of(dotted)
        if rel is None:
            return ("unresolved",) if self.res.is_internal_root(dotted) else ("external", dotted)
        if not rest:
            return ("module", rel, [])
        shape = self.res.shapes.get(rel)
        if shape is None:
            return ("unresolved",)
        name, tail = rest[0], rest[1:]
        kind = shape["defs"].get(name)
        if kind:
            return ("node", node_id(kind, rel, name), tail)
        if name in shape["binds"]:
            return self.locate(".".join([shape["binds"][name]] + tail), hops + 1)
        if name in shape["vars"]:
            return ("var", rel, name, tail)
        for star in shape["stars"]:
            srel, srest = self.res.module_of(star)
            if srel is not None and not srest and name in exported_names(self.res.shapes.get(srel, {"defs": {}, "binds": {}, "vars": [], "all": None})):
                return self.locate(".".join([star, name] + tail), hops + 1)
        return ("unresolved",)

    def ref_target(self, v: Any, file: str) -> Tuple:
        """Locate a val(): {"ref"} → locate; {"local"} → var in this file; {"call"} → locate the callee."""
        if isinstance(v, dict):
            if "ref" in v:
                return self.locate(v["ref"])
            if "local" in v:
                head, *tail = v["local"].split(".")
                return ("var", file, head, tail)
            if v.get("call"):
                c = v["call"]
                if c.startswith("local:"):
                    head, *tail = c[6:].split(".")
                    return ("var", file, head, tail)
                return self.locate(c)
        return ("unresolved",)

    def node_of(self, v: Any, file: str) -> Optional[str]:
        t = self.ref_target(v, file)
        return t[1] if t[0] == "node" and not t[2] else None

    def var_value(self, rel: str, name: str) -> Any:
        """Last `=` value of a module-level (or factory-local) variable."""
        ff = self.facts.get(rel, {})
        vals = [a for a in ff.get("assigns", {}).get(name, []) if a[0] == "="]
        if vals:
            return vals[-1][1]
        loc = [a for a in ff.get("local_assigns", []) if a["name"] == name]
        return loc[-1]["value"] if loc else None

    def ancestry(self, cid: str) -> Tuple[List[str], Set[str]]:
        """(internal ancestor ids incl. self, external dotted base names)."""
        if cid in self._anc:
            return self._anc[cid]
        self._anc[cid] = ([cid], set())
        internal, external = [cid], set()
        c = self.classes.get(cid)
        for b in (c or {}).get("bases", []):
            t = self.ref_target(b, c["file"])
            if t[0] == "node" and not t[2] and t[1] in self.classes:
                i, e = self.ancestry(t[1])
                internal += [x for x in i if x not in internal]
                external |= e
            elif t[0] == "external":
                external.add(t[1])
            elif t[0] == "var":
                # Base = declarative_base(); db.Model where db = SQLAlchemy()
                v = self.var_value(t[1], t[2])
                call = v.get("call") if isinstance(v, dict) else None
                if call in SQLA_BASE_FACTORIES and not t[3]:
                    external.add("sqlalchemy.orm.DeclarativeBase")
                elif call in FLASK_SQLA and t[3] == ["Model"]:
                    external.add("sqlalchemy.orm.DeclarativeBase")
        self._anc[cid] = (internal, external)
        return self._anc[cid]

    def ext_names(self, cid: str) -> Set[str]:
        return {e.split(".")[-1] for e in self.ancestry(cid)[1]}

    def is_a(self, cid: str, bases: Set[str]) -> bool:
        return bool(self.ancestry(cid)[1] & bases)

    # -- endpoint helper
    def endpoint(self, eid: str, file: str, line: int, parent: str, fw: str, methods: List[str], template: str, full: Optional[str],
                 handler: Optional[str], chain: List[Tuple[Optional[str], str, int]], label: Optional[str] = None) -> str:
        n = self.endpoint_ids.get(eid, 0) + 1
        self.endpoint_ids[eid] = n
        if n > 1:
            eid = f"{eid}~{n}"
        http = {"methods": methods, "pathTemplate": template}
        if full is not None:
            http["fullPath"] = full
        self.nodes.append({"id": eid, "kind": "endpoint", "label": label or f"{'|'.join(methods)} {full if full is not None else template}",
                           "parent": parent, "level": 3, "lang": "py", "path": file, "line": line, "meta": {"framework": fw, "http": http}})
        self.bump(f"{fw}.endpoints")
        self.saw(file, fw)
        if handler:
            self.edge("handles", eid, handler, file, line)
        else:
            self.bump("http.unresolvedHandlers")
            self.warn("py-http-unresolved-handler", "Route handlers that could not be resolved to a function or class", file)
        order = 0
        for nid, p, ln in chain:
            if nid:
                self.edge("middleware-chain", eid, nid, p, ln, meta={"order": order})
            else:
                self.bump("http.externalMiddleware")
            order += 1
        return eid

    def group_node(self, gid: str, label: str, file: str, line: int, fw: str, role: str) -> None:
        if gid in self.node_by_id or any(n["id"] == gid for n in self.nodes):
            return
        from .extract import node_id
        self.nodes.append({"id": gid, "kind": "route-group", "label": label, "parent": node_id("module", file), "level": 3,
                           "lang": "py", "path": file, "line": line, "meta": {"framework": fw, "role": role}})

    # ================================================================ run
    def run(self) -> None:
        self.classify_classes()
        self.groups_and_routes()
        self.django()
        self.dependencies_and_validation()
        self.orm()

    # -- models / schemas / serializers
    def classify_classes(self) -> None:
        from .extract import node_id
        self.models: Dict[str, str] = {}      # class id → framework
        self.tables: Dict[str, str] = {}      # __tablename__ → class id
        for cid, c in sorted(self.classes.items()):
            if self.is_a(cid, DJANGO_MODEL):
                abstract = c["meta"].get("abstract") is True
                self.models[cid] = "django"
                self.patch(cid, framework="django", role="abstract-model" if abstract else "model")
                self.saw(c["file"], "django")
            elif self.is_a(cid, SQLA_BASES) and (("__tablename__" in c["attrs"]) or any(self.sqla_column(f) for f in c["fields"])):
                self.models[cid] = "sqlalchemy"
                tn = c["attrs"].get("__tablename__")
                self.tables[tn if isinstance(tn, str) else snake(c["name"])] = cid
                self.patch(cid, framework="sqlalchemy", role="model")
                self.saw(c["file"], "sqlalchemy")
            elif self.is_a(cid, SETTINGS):
                self.patch(cid, framework="pydantic", role="settings")
            elif self.is_a(cid, PYDANTIC):
                self.patch(cid, framework="pydantic", role="schema", fields=self.annotated_fields(c))
                self.saw(c["file"], "pydantic")
            elif any(e.startswith("rest_framework.serializers.") for e in self.ancestry(cid)[1]):
                self.patch(cid, framework="drf", role="serializer", fields=self.serializer_fields(c))
                self.saw(c["file"], "drf")
                m = c["meta"].get("model")
                mid = self.node_of(m, c["file"]) if m else None
                if mid:
                    self.edge("serializes", cid, mid, c["file"], c["line"])
            elif self.is_a(cid, {"django.apps.AppConfig", "django.apps.config.AppConfig"}):
                self.patch(cid, framework="django", role="app-config")
        # fields + relations (after all models are known, so string refs resolve)
        for cid, fw in sorted(self.models.items()):
            c = self.classes[cid]
            fields = self.django_fields(cid, c) if fw == "django" else self.sqla_fields(cid, c)
            if fw == "django":  # fields inherited from internal abstract bases come first, like Django's own ordering
                inherited = [f for a in reversed(self.ancestry(cid)[0][1:]) if self.patches.get(a, {}).get("role") == "abstract-model"
                             for f in self.django_fields(a, self.classes[a])]
                fields = inherited + fields
            self.patch(cid, fields=[{k: v for k, v in f.items() if k in ("name", "type", "relation")} for f in fields])
            for f in fields:
                if f.get("target"):
                    self.edge("model-relation", cid, f["target"], c["file"], f["line"])

    def annotated_fields(self, c) -> List[Dict[str, str]]:
        return [{"name": f["name"], "type": f["ann"]} for f in c["fields"] if f.get("ann") and not f["ann"].startswith("ClassVar") and f["name"] != "model_config"]

    def serializer_fields(self, c) -> List[Dict[str, str]]:
        out = [{"name": f["name"], "type": (f["value"].get("call") or "?").split(".")[-1]} for f in c["fields"] if isinstance(f.get("value"), dict) and f["value"].get("call")]
        mf = c["meta"].get("fields")
        if isinstance(mf, list):
            have = {f["name"] for f in out}
            out += [{"name": x, "type": "model field"} for x in mf if isinstance(x, str) and x not in have]
        return out

    def model_by_name(self, name: str, near_file: str, app_label: Optional[str] = None) -> Optional[str]:
        cands = [cid for cid in self.models if self.classes[cid]["name"] == name]
        if app_label:
            cands = [c for c in cands if app_label in self.classes[c]["file"].split("/")[:-1]] or cands
        if len(cands) > 1:
            same = [c for c in cands if posixpath.dirname(self.classes[c]["file"]) == posixpath.dirname(near_file)]
            cands = same or cands
        return sorted(cands)[0] if cands else None

    def django_fields(self, cid: str, c) -> List[Dict[str, Any]]:
        out = []
        rel_kinds = {"ForeignKey": "fk", "OneToOneField": "o2o", "ManyToManyField": "m2m"}
        for f in c["fields"]:
            v = f.get("value")
            if not isinstance(v, dict) or not v.get("call"):
                continue
            typ = v["call"].split(".")[-1]
            if not typ.endswith(("Field", "Key")) and typ not in rel_kinds:
                continue
            item: Dict[str, Any] = {"name": f["name"], "type": typ, "line": f["line"]}
            if typ in rel_kinds:
                item["relation"] = rel_kinds[typ]
                tgt = v["args"][0] if v["args"] else v["kw"].get("to")
                if isinstance(tgt, str):
                    if tgt == "self":
                        item["target"] = cid
                    elif "." in tgt:
                        label, mname = tgt.rsplit(".", 1)
                        item["target"] = self.model_by_name(mname, c["file"], label)
                    else:
                        item["target"] = self.model_by_name(tgt, c["file"])
                    if not item["target"]:
                        item.pop("target")
                        item["relation"] += f" → {tgt}"
                else:
                    t = self.node_of(tgt, c["file"])
                    if t in self.models:
                        item["target"] = t
                    else:
                        item["relation"] += " → external"
            out.append(item)
        return out

    def sqla_column(self, f) -> bool:
        v = f.get("value")
        call = v.get("call") if isinstance(v, dict) else None
        ann = f.get("ann") or ""
        return bool(call and call.split(".")[-1] in ("Column", "mapped_column", "relationship")) or ann.startswith("Mapped[")

    def sqla_fields(self, cid: str, c) -> List[Dict[str, Any]]:
        out = []
        for f in c["fields"]:
            if not self.sqla_column(f):
                continue
            v = f.get("value") if isinstance(f.get("value"), dict) else {}
            call = (v.get("call") or "").split(".")[-1]
            ann = f.get("ann") or ""
            m = re.match(r"^Mapped\[(.*)\]$", ann)
            inner = m.group(1) if m else ""
            item: Dict[str, Any] = {"name": f["name"], "type": inner.replace("'", "").replace('"', "") or (self.col_type(v) if call == "Column" else call or "?"), "line": f["line"]}
            if call == "relationship":
                tgt = v["args"][0] if v.get("args") else None
                name = tgt if isinstance(tgt, str) else None
                if name is None:
                    mm = re.search(r"""['"]?(\w+)['"]?\]*$""", inner.replace("list[", "").replace("List[", "").replace("Optional[", ""))
                    name = mm.group(1) if mm else None
                t = self.model_by_name(name, c["file"]) if name else None
                if t is None and isinstance(tgt, dict):
                    t = self.node_of(tgt, c["file"])
                item["relation"] = "many" if inner.lower().startswith(("list[", "set[")) or (v.get("kw", {}).get("uselist") is True) else "relationship"
                if t in self.models:
                    item["target"] = t
            for a in v.get("args", []) if call in ("Column", "mapped_column") else []:
                if isinstance(a, dict) and (a.get("call") or "").split(".")[-1] == "ForeignKey" and a.get("args") and isinstance(a["args"][0], str):
                    table = a["args"][0].split(".")[0]
                    item["relation"] = f"fk ({a['args'][0]})"
                    if self.tables.get(table):
                        item["target"] = self.tables[table]
            out.append(item)
        return out

    def col_type(self, v) -> str:
        for a in v.get("args", []):
            if isinstance(a, dict) and ("ref" in a or a.get("call")):
                name = (a.get("ref") or a.get("call") or "").split(".")[-1]
                if name and name != "ForeignKey":
                    return name
        return "Column"

    # -- FastAPI + Flask groups, routes, mounts
    def group_of(self, v: Any, file: str) -> Optional[Tuple[str, str, str, Any, str, int]]:
        """val → (group id, framework, role, factory call val, file, line) when it's a FastAPI/Flask/DRF factory var."""
        t = self.ref_target(v, file)
        if t[0] != "var" or t[3]:
            return None
        rel, name = t[1], t[2]
        call = self.var_value(rel, name)
        if not isinstance(call, dict) or call.get("call") not in FACTORIES:
            return None
        fw, role = FACTORIES[call["call"]]
        return (f"py:route-group:{rel}#{name}", fw, role, call, rel, call.get("line", 1))

    def receiver_method(self, callv: Any, file: str) -> Optional[Tuple[Tuple, str]]:
        """{"call": "pkg.app.get"} → (group tuple, 'get')."""
        if not isinstance(callv, dict) or not callv.get("call"):
            return None
        c = callv["call"]
        head, _, meth = c.rpartition(".")
        if not head:
            return None
        g = self.group_of({"local": head[6:]} if head.startswith("local:") else {"ref": head}, file)
        return (g, meth) if g else None

    def groups_and_routes(self) -> None:
        from .extract import node_id
        groups: Dict[str, Dict[str, Any]] = {}

        def reg(g) -> Dict[str, Any]:
            gid, fw, role, call, rel, line = g
            if gid not in groups:
                prefix = call["kw"].get("prefix") if fw == "fastapi" else call["kw"].get("url_prefix") if fw == "flask" else None
                groups[gid] = {"id": gid, "fw": fw, "role": role, "file": rel, "line": line, "prefix": prefix if isinstance(prefix, str) else "",
                               "deps": call["kw"].get("dependencies") or [], "routes": [], "mounts": [], "mws": [], "hooks": [], "registers": []}
            return groups[gid]

        # routes from decorators
        for fid, fn in sorted(self.functions.items()):
            for d in fn["decorators"]:
                rm = self.receiver_method(d, fn["file"])
                if not rm:
                    continue
                g, meth = rm
                grp = reg(g)
                if grp["fw"] == "fastapi" and (meth in HTTP or meth == "api_route"):
                    path = d["args"][0] if d["args"] else d["kw"].get("path")
                    methods = [meth.upper()] if meth != "api_route" else [m.upper() for m in (d["kw"].get("methods") or ["GET"]) if isinstance(m, str)]
                    grp["routes"].append({"fn": fid, "file": fn["file"], "line": d.get("line", fn["line"]), "path": path, "methods": methods,
                                          "response_model": d["kw"].get("response_model"), "deps": d["kw"].get("dependencies") or []})
                elif grp["fw"] == "fastapi" and meth == "middleware":
                    grp["mws"].append((fid, fn["file"], d.get("line", fn["line"])))
                elif grp["fw"] == "flask" and (meth in HTTP or meth == "route"):
                    path = d["args"][0] if d["args"] else d["kw"].get("rule")
                    methods = [meth.upper()] if meth != "route" else sorted({m.upper() for m in (d["kw"].get("methods") or ["GET"]) if isinstance(m, str)})
                    grp["routes"].append({"fn": fid, "file": fn["file"], "line": d.get("line", fn["line"]), "path": path, "methods": methods, "deps": []})
            for d in fn["decorators"]:
                # bare decorators: @app.before_request / @bp.after_request
                if isinstance(d, dict) and ("ref" in d or "local" in d):
                    dotted = d.get("ref") or d.get("local")
                    head, _, meth = dotted.rpartition(".")
                    if meth in ("before_request", "after_request") and head:
                        g = self.group_of({"ref": head} if "ref" in d else {"local": head}, fn["file"])
                        if g:
                            reg(g)["hooks"].append((meth, fid, fn["file"], fn["line"]))
        # calls: include_router / register_blueprint / add_middleware / add_url_rule / before_request(fn) / router.register
        for f, ff in sorted(self.facts.items()):
            for c in ff.get("calls", []):
                rm = self.receiver_method(c, f)
                if not rm:
                    continue
                g, meth = rm
                grp = reg(g)
                if meth in ("include_router", "register_blueprint") and c["args"]:
                    child = self.group_of(c["args"][0], f)
                    if child:
                        reg(child)
                        key = "prefix" if meth == "include_router" else "url_prefix"
                        p = c["kw"].get(key)
                        grp["mounts"].append({"child": child[0], "prefix": p if isinstance(p, str) else None, "deps": c["kw"].get("dependencies") or [], "file": f, "line": c["line"]})
                    else:
                        self.warn("py-unresolved-mount", "include_router/register_blueprint targets that could not be resolved", f)
                elif meth == "add_middleware" and c["args"]:
                    grp["mws"].append((self.node_of(c["args"][0], f), f, c["line"]))
                elif meth in ("before_request", "after_request") and c["args"]:
                    nid = self.node_of(c["args"][0], f)
                    if nid:
                        grp["hooks"].append((meth, nid, f, c["line"]))
                elif meth == "add_url_rule" and grp["fw"] == "flask":
                    path = c["args"][0] if c["args"] else c["kw"].get("rule")
                    vf = c["kw"].get("view_func") or (c["args"][2] if len(c["args"]) > 2 else None)
                    view = self.view_of(vf, f)
                    methods = c["kw"].get("methods")
                    if methods is None and view and view in self.classes:
                        methods = [m["name"].upper() for m in self.classes[view]["methods"] if m["name"] in HTTP]
                    grp["routes"].append({"fn": view, "file": f, "line": c["line"], "path": path,
                                          "methods": sorted({m.upper() for m in (methods or ["GET"]) if isinstance(m, str)}), "deps": []})
                elif meth == "register" and grp["fw"] == "drf" and len(c["args"]) >= 2:
                    grp["registers"].append({"prefix": c["args"][0], "view": self.node_of(c["args"][1], f), "file": f, "line": c["line"]})
        self.drf_routers = {gid: g for gid, g in groups.items() if g["fw"] == "drf"}
        for g in groups.values():
            g["mws"].sort(key=lambda m: (m[1], m[2]))  # registration order = source order

        # contexts: prefix + dependency chain, from each app
        contexts: Dict[str, List[Tuple[str, List[Tuple[Any, str, int]], str]]] = {}

        def visit(gid: str, prefix: str, deps: List, app: str, stack: List[str], override: Optional[str] = None) -> None:
            if gid in stack or len(stack) > 20:
                self.warn("py-mount-cycle", "Router/blueprint mount cycle (ignored)", groups[gid]["file"])
                return
            g = groups[gid]
            own = prefix + (override if override is not None else (g["prefix"] if g["role"] != "app" else ""))
            gdeps = deps + [(d, g["file"], g["line"]) for d in (g["deps"] if isinstance(g["deps"], list) else [])]
            contexts.setdefault(gid, []).append((own, gdeps, app))
            for m in g["mounts"]:
                mdeps = gdeps + [(d, m["file"], m["line"]) for d in (m["deps"] if isinstance(m["deps"], list) else [])]
                if groups[m["child"]]["fw"] == "flask":
                    # register_blueprint(url_prefix=…) replaces the blueprint's own url_prefix
                    visit(m["child"], own, mdeps, app, stack + [gid], override=m["prefix"])
                else:
                    visit(m["child"], own + (m["prefix"] or ""), mdeps, app, stack + [gid])

        for gid in sorted(g for g in groups if groups[g]["role"] == "app"):
            visit(gid, "", [], gid, [])
        for gid in sorted(groups):
            g = groups[gid]
            if g["fw"] == "drf":
                continue
            self.saw(g["file"], g["fw"])
            self.group_node(gid, f"{gid.split('#')[-1]} ({g['fw']} {g['role']}, {posixpath.basename(g['file'])})", g["file"], g["line"], g["fw"], g["role"])
            for m in g["mounts"]:
                self.edge("mounts", gid, m["child"], m["file"], m["line"], meta={"prefix": m["prefix"]} if m["prefix"] else None)
            ctxs = contexts.get(gid, [])
            if g["routes"] and len(ctxs) != 1:
                self.warn("py-multi-mount" if ctxs else "py-unmounted-router",
                          "Routers/blueprints mounted more than once (fullPath unset)" if ctxs else "Routers/blueprints never mounted on an app (fullPath unknown)", g["file"])
            ctx = ctxs[0] if len(ctxs) == 1 else None
            for r in g["routes"]:
                if not isinstance(r["path"], str):
                    self.warn("py-dynamic-path", "Routes with a non-literal path (not listed)", r["file"])
                    continue
                app = groups.get(ctx[2]) if ctx else None
                chain: List[Tuple[Optional[str], str, int]] = []
                if app and g["fw"] == "fastapi":
                    chain += [(nid, f, ln) for nid, f, ln in reversed(app["mws"])]  # last added runs first
                if g["fw"] == "flask":
                    for meth in ("before_request", "after_request"):
                        hooks = (app["hooks"] if app and app is not g else []) + g["hooks"]
                        chain += [(nid, f, ln) for m, nid, f, ln in hooks if m == meth]
                local = (g["prefix"] if g["role"] != "app" else "") + r["path"]
                full = ctx[0] + r["path"] if ctx else None
                handler = r["fn"]
                eid = self.endpoint(f"py:endpoint:{r['file']}#{(handler or '?').split('#')[-1]}" if handler else f"py:endpoint:{r['file']}#{r['path']}",
                                    r["file"], r["line"], gid, g["fw"], r["methods"], local, full, handler, chain)
                self.saw(r["file"], g["fw"])
                if g["fw"] == "fastapi":
                    for d, f, ln in (ctx[1] if ctx else []) + [(d, r["file"], r["line"]) for d in r["deps"]]:
                        dep = self.depends_target(d, f)
                        if dep:
                            self.edge("injects", eid, dep, f, ln)
                    rm = r.get("response_model")
                    for sid in self.schema_refs(rm, r["file"]):
                        self.edge("validates", eid, sid, r["file"], r["line"])

    def view_of(self, v: Any, file: str) -> Optional[str]:
        """FBV ref → function id; Foo.as_view(...) / Foo.as_<custom>_view(...) → class id; csrf_exempt(view) etc. → the wrapped view."""
        if isinstance(v, dict) and v.get("call"):
            call = v["call"]
            meth = call.rsplit(".", 1)[-1]
            if "." in call and re.match(r"as_\w*view$", meth):
                base = call[: -(len(meth) + 1)]
                return self.node_of({"local": base[6:]} if base.startswith("local:") else {"ref": base}, file)
            if v.get("args"):  # decorator applied inline: csrf_exempt(view), login_required(view)
                inner = self.view_of(v["args"][0], file)
                if inner:
                    return inner
        return self.node_of(v, file)

    def depends_target(self, v: Any, file: str) -> Optional[str]:
        if isinstance(v, dict) and (v.get("call") or "").split(".")[-1] in ("Depends", "Security") and v.get("args"):
            return self.node_of(v["args"][0], file)
        return None

    def schema_refs(self, v: Any, file: str) -> List[str]:
        """Pydantic schema classes referenced by an annotation/response_model value (list[X], Optional[X], X | None…)."""
        out: List[str] = []

        def walk(x: Any) -> None:
            if isinstance(x, list):
                for i in x:
                    walk(i)
            elif isinstance(x, dict):
                if "ref" in x or "local" in x:
                    nid = self.node_of(x, file)
                    if nid and self.patches.get(nid, {}).get("role") == "schema":
                        out.append(nid)
                elif "sub" in x:
                    walk(x["sub"])
                    walk(x["index"])
                elif "expr" in x:
                    return
        walk(v)
        return out

    # -- dependency injection + validation across all functions
    def dependencies_and_validation(self) -> None:
        handlers = {e["target"] for e in self.edges.values() if e["kind"] == "handles"}
        for fid, fn in sorted(self.functions.items()):
            for p in fn["params"]:
                dep = self.depends_target(p["default"], fn["file"])
                ann = p["ann"]
                if not dep and isinstance(ann, dict) and "sub" in ann and isinstance(ann["index"], list):
                    for x in ann["index"][1:]:
                        dep = dep or self.depends_target(x, fn["file"])
                if dep:
                    self.edge("injects", fid, dep, fn["file"], fn["line"])
                    self.saw(fn["file"], "fastapi")
                elif ann is not None:
                    for sid in self.schema_refs(ann, fn["file"]):
                        if fid in handlers:
                            self.edge("validates", fid, sid, fn["file"], fn["line"])

    # -- Django
    def django(self) -> None:
        from .extract import node_id
        files = sorted(self.fragments)
        if not any(f.endswith("manage.py") for f in self.files) and not any(fw == "django" for fw in self.models.values()):
            return
        settings_mod = self.config.get("djangoSettings")
        inferred_settings = False
        if not settings_mod:
            for f in files:
                v = self.facts[f].get("env_defaults", {}).get("DJANGO_SETTINGS_MODULE")
                if isinstance(v, str):
                    settings_mod = v
                    break
        if not settings_mod:
            cands = sorted((m for m in self.res.index if m.split(".")[-1] == "settings" or m.endswith(".settings.base")), key=lambda m: (m.count("."), m))
            settings_mod = cands[0] if cands else None
            inferred_settings = bool(settings_mod)
            if settings_mod:
                self.warn("django-settings-guessed", f"DJANGO_SETTINGS_MODULE not found as a literal; using {settings_mod} (inferred)")
        srel = self.res.index.get(settings_mod) if settings_mod else None
        if not srel:
            if settings_mod:
                self.warn("django-settings-unresolved", f"Settings module {settings_mod} is not in the repo")
            else:
                self.warn("django-settings-missing", "No Django settings module found; URLconf not walked")
            return
        self.saw(srel, "django")
        self.patch(node_id("module", srel), framework="django", role="settings")
        get = lambda name: self.setting(srel, name, set())
        apps = get("INSTALLED_APPS")
        if isinstance(apps, list):
            for a in apps:
                if not isinstance(a, str):
                    continue
                mod = a.rsplit(".apps.", 1)[0] if ".apps." in a else a
                rel = self.res.index.get(mod)
                if rel:
                    gdir = posixpath.dirname(rel) if rel.endswith("__init__.py") else posixpath.dirname(rel) or "."
                    self.patch(node_id("module-group", gdir or "."), framework="django", role="django-app")
                    self.bump("django.apps")
        elif apps == "dynamic":
            self.warn("django-settings-dynamic", "INSTALLED_APPS is not a literal list (apps not detected)", srel)
        mw = get("MIDDLEWARE")
        self.django_mw: List[Tuple[Optional[str], str, int]] = []
        if isinstance(mw, list):
            for m in mw:
                t = self.locate(m) if isinstance(m, str) else ("unresolved",)
                self.django_mw.append((t[1] if t[0] == "node" and not t[2] else None, srel, 1))
        elif mw == "dynamic":
            self.warn("django-settings-dynamic", "MIDDLEWARE is not a literal list (chain unknown)", srel)
        root = get("ROOT_URLCONF")
        rrel = self.res.index.get(root) if isinstance(root, str) else None
        if not rrel:
            self.warn("django-urlconf-unresolved", "ROOT_URLCONF is missing, non-literal, or outside the repo", srel)
            return
        self.walk_urlconf(rrel, "", [], 0, inferred_settings)
        # signals + management commands
        for fid, fn in sorted(self.functions.items()):
            for d in fn["decorators"]:
                if isinstance(d, dict) and d.get("call") in ("django.dispatch.receiver", "django.dispatch.dispatcher.receiver"):
                    self.patch(fid, framework="django", role="signal-handler")
                    sender = self.node_of(d["kw"].get("sender"), fn["file"]) if d["kw"].get("sender") else None
                    if sender:
                        self.edge("calls", sender, fid, fn["file"], fn["line"], inferred=True)
        for f in files:
            m = re.match(r"^(.*)/management/commands/([A-Za-z_]\w*)\.py$", f)
            if not m or m.group(2).startswith("_"):
                continue
            cid = node_id("class", f, "Command")
            if cid not in self.classes:
                continue
            self.patch(cid, framework="django", role="management-command")
            proj = next((p for p in sorted(self.projects, key=lambda p: -len(p["root"])) if p["root"] == "." or f.startswith(p["root"] + "/")), None)
            sid = f"config:script:{f}#{m.group(2)}"
            self.nodes.append({"id": sid, "kind": "script", "label": m.group(2), "parent": node_id("project", proj["root"]) if proj else None, "level": 3,
                               "lang": "config", "path": f, "line": self.classes[cid]["line"], "meta": {"signature": f"python manage.py {m.group(2)}", "role": "management-command"}})
            h = node_id("method", f, "Command.handle")
            self.edge("handles", sid, h if h in self.node_by_id else cid, f, self.classes[cid]["line"])

    def setting(self, rel: str, name: str, seen: Set[str]) -> Any:
        """Evaluate a settings value: star-imported base settings first, then own `=` / `+=` (literal lists/strings only)."""
        if rel in seen:
            return None
        seen.add(rel)
        value: Any = None
        for star in self.res.shapes.get(rel, {}).get("stars", []):
            srel = self.res.index.get(star)
            if srel:
                v = self.setting(srel, name, seen)
                if v is not None:
                    value = v
        for op, v, _ in self.facts.get(rel, {}).get("assigns", {}).get(name, []):
            lit = v if isinstance(v, (str, list)) and (not isinstance(v, list) or all(isinstance(x, str) for x in v)) else None
            if lit is None:
                return "dynamic"
            value = lit if op == "=" or not isinstance(value, list) else value + lit
        return value

    def url_entries(self, v: Any, file: str) -> List[Any]:
        if isinstance(v, list):
            return v
        if isinstance(v, dict) and "concat" in v:
            return [x for part in v["concat"] for x in (self.url_entries(part, file) if not (isinstance(part, dict) and "ref" in part and part["ref"].endswith(".urls")) else [{"router_urls": part}])]
        if isinstance(v, dict) and ("ref" in v or "local" in v) and (v.get("ref") or v.get("local", "")).endswith(".urls"):
            return [{"router_urls": v}]
        return []

    def walk_urlconf(self, rel: str, prefix: str, chain: List, depth: int, inferred: bool) -> None:
        from .extract import node_id
        if depth > 12:
            return
        self.saw(rel, "django")
        gid = f"py:route-group:{rel}"
        self.group_node(gid, f"urls ({posixpath.basename(posixpath.dirname(rel)) or rel})", rel, 1, "django", "urlconf")
        self.patch(node_id("module", rel), framework="django", role="urlconf")
        entries: List[Any] = []
        for op, v, _ in self.facts.get(rel, {}).get("assigns", {}).get("urlpatterns", []):
            es = self.url_entries(v, rel)
            entries = es if op == "=" else entries + es
        for e in entries:
            if isinstance(e, dict) and "router_urls" in e:
                self.expand_router(e["router_urls"], rel, prefix, gid)
                continue
            if not isinstance(e, dict) or not e.get("call"):
                continue
            fn = e["call"].split(".")[-1]
            if fn not in ("path", "re_path", "url") or not e["args"]:
                continue
            route = e["args"][0]
            if not isinstance(route, str):
                self.warn("py-dynamic-path", "URL patterns with a non-literal route (not listed)", rel)
                continue
            if fn != "path":
                route = route.lstrip("^").rstrip("$")
            view = e["args"][1] if len(e["args"]) > 1 else e["kw"].get("view")
            line = e.get("line", 1)
            if isinstance(view, dict) and (view.get("call") or "").split(".")[-1] == "include":
                tgt = view["args"][0] if view["args"] else None
                if isinstance(tgt, list) and tgt:
                    tgt = tgt[0]
                if isinstance(tgt, str):
                    crel = self.res.index.get(tgt)
                    if crel:
                        self.edge("mounts", gid, f"py:route-group:{crel}", rel, line, meta={"prefix": route} if route else None)
                        self.walk_urlconf(crel, prefix + route, chain, depth + 1, inferred)
                    else:
                        self.bump("django.externalIncludes")
                elif isinstance(tgt, dict) and (tgt.get("ref") or tgt.get("local")):
                    # include(<imported urls module>) first; `router.urls` (a DRF router attribute) second.
                    crel = self.res.index.get(tgt["ref"]) if tgt.get("ref") else None
                    if crel:
                        self.edge("mounts", gid, f"py:route-group:{crel}", rel, line, meta={"prefix": route} if route else None)
                        self.walk_urlconf(crel, prefix + route, chain, depth + 1, inferred)
                    elif (tgt.get("ref") or tgt.get("local", "")).endswith(".urls"):
                        self.expand_router(tgt, rel, prefix + route, gid, line)
                    else:
                        self.bump("django.externalIncludes")
                else:
                    self.bump("django.externalIncludes")
                continue
            if isinstance(view, dict) and (view.get("ref") or "").endswith(".urls"):
                self.bump("django.externalIncludes")  # admin.site.urls and friends
                continue
            vid = self.view_of(view, rel)
            methods, handler = self.view_methods(vid)
            self.endpoint(f"py:endpoint:{rel}#{prefix + route}", rel, line, gid, "django", methods, route, "/" + prefix + route, handler,
                          list(self.django_mw) + self.permission_chain(vid))

    def view_methods(self, vid: Optional[str]) -> Tuple[List[str], Optional[str]]:
        if not vid:
            return ["*"], None
        if vid in self.classes:
            own = {m["name"] for cid in self.ancestry(vid)[0] for m in self.classes.get(cid, {}).get("methods", [])}
            methods = {m.upper() for m in own if m in HTTP}
            mine = {m["name"] for m in self.classes.get(vid, {}).get("methods", [])} & set(HTTP)
            if not mine and len(methods) >= 4:
                # Every verb comes from an in-repo base dispatcher (e.g. a shared APIView base): which ones really work isn't static.
                methods = set()
            for e in self.ext_names(vid):
                methods |= set(GENERIC_VIEW_METHODS.get(e, []))
            self.patch(vid, framework="drf" if any(x.startswith("rest_framework.") for x in self.ancestry(vid)[1]) else "django", role="view")
            return sorted(methods) or ["*"], vid
        fn = self.functions.get(vid, {})
        for d in fn.get("decorators", []):
            c = (d.get("call") or "") if isinstance(d, dict) else ""
            if c.endswith("api_view") and d["args"] and isinstance(d["args"][0], list):
                self.patch(vid, framework="drf", role="view")
                return sorted({m.upper() for m in d["args"][0] if isinstance(m, str)}), vid
            if c.endswith("require_http_methods") and d["args"] and isinstance(d["args"][0], list):
                return sorted({m.upper() for m in d["args"][0] if isinstance(m, str)}), vid
        for d in fn.get("decorators", []):
            r = (d.get("ref") or "") if isinstance(d, dict) else ""
            for name, m in (("require_GET", "GET"), ("require_POST", "POST"), ("require_safe", "GET")):
                if r.endswith(name):
                    return [m], vid
        self.patch(vid, framework="django", role="view")
        return ["*"], vid

    def permission_chain(self, vid: Optional[str]) -> List[Tuple[Optional[str], str, int]]:
        if not vid or vid not in self.classes:
            return []
        for cid in self.ancestry(vid)[0]:
            c = self.classes.get(cid, {})
            pc = c.get("attrs", {}).get("permission_classes")
            if isinstance(pc, list):
                return [(self.node_of(p, c["file"]), c["file"], c["line"]) for p in pc]
        return []

    def expand_router(self, urls_ref: Any, file: str, prefix: str, parent_gid: str, line: int = 1) -> None:
        dotted = urls_ref.get("ref") or urls_ref.get("local")
        base = dotted[: -len(".urls")]
        g = self.group_of({"ref": base} if "ref" in urls_ref else {"local": base}, file)
        if not g or g[0] not in self.drf_routers:
            self.warn("drf-router-unresolved", "include(router.urls) where the router could not be resolved", file)
            return
        router = self.drf_routers[g[0]]
        self.group_node(router["id"], f"{router['id'].split('#')[-1]} (drf router, {posixpath.basename(router['file'])})", router["file"], router["line"], "drf", "router")
        self.edge("mounts", parent_gid, router["id"], file, line, meta={"prefix": prefix} if prefix else None)
        self.saw(router["file"], "drf")
        for r in router["registers"]:
            vs = r["view"]
            if not isinstance(r["prefix"], str):
                continue
            p = r["prefix"].strip("^$").strip("/")
            if not vs or vs not in self.classes:
                self.endpoint(f"py:endpoint:{router['file']}#{p}", router["file"], r["line"], router["id"], "drf", ["*"], p + "/", "/" + prefix + p + "/", None, [])
                continue
            self.patch(vs, framework="drf", role="viewset")
            c = self.classes[vs]
            lookup = c["attrs"].get("lookup_field") if isinstance(c["attrs"].get("lookup_field"), str) else "pk"
            own = {m["name"]: (cid, m) for cid in reversed(self.ancestry(vs)[0]) for m in self.classes.get(cid, {}).get("methods", [])}
            actions = set(a for a in ACTION_ROUTES if a in own)
            for e in self.ext_names(vs):
                actions |= set(VIEWSET_ACTIONS.get(e, []))
            chain = list(self.django_mw) + self.permission_chain(vs)
            for a in sorted(actions, key=lambda x: list(ACTION_ROUTES).index(x)):
                method, detail = ACTION_ROUTES[a]
                route = f"{p}/<{lookup}>/" if detail else f"{p}/"
                handler = f"py:method:{self.classes[own[a][0]]['file']}#{self.classes[own[a][0]]['name']}.{a}" if a in own else vs
                self.endpoint(f"py:endpoint:{router['file']}#{method} {route}", router["file"], r["line"], router["id"], "drf",
                              [method], route, "/" + prefix + route, handler, chain)
            for name, (cid, m) in sorted(own.items()):
                for d in m["decorators"]:
                    if isinstance(d, dict) and (d.get("call") or "").split(".")[-1] == "action":
                        detail = d["kw"].get("detail") is True
                        url_path = d["kw"].get("url_path") if isinstance(d["kw"].get("url_path"), str) else name
                        methods = sorted({x.upper() for x in (d["kw"].get("methods") or ["get"]) if isinstance(x, str)})
                        route = f"{p}/<{lookup}>/{url_path}/" if detail else f"{p}/{url_path}/"
                        handler = f"py:method:{self.classes[cid]['file']}#{self.classes[cid]['name']}.{name}"
                        self.endpoint(f"py:endpoint:{router['file']}#{'|'.join(methods)} {route}", router["file"], r["line"], router["id"], "drf",
                                      methods, route, "/" + prefix + route, handler, chain)
            sc = c["attrs"].get("serializer_class")
            sid = self.node_of(sc, c["file"]) if sc else None
            if sid:
                self.edge("serializes", vs, sid, c["file"], c["line"])
            qs = c["attrs"].get("queryset")
            if isinstance(qs, dict) and qs.get("call"):
                t = self.locate(qs["call"]) if not qs["call"].startswith("local:") else ("unresolved",)
                if t[0] == "node" and t[1] in self.models:
                    self.edge("reads-model", vs, t[1], c["file"], c["line"])

    # -- ORM reads/writes
    def orm(self) -> None:
        for f, ff in sorted(self.facts.items()):
            for u in ff.get("orm", []):
                t = self.locate(u["model"])
                if t[0] != "node" or t[2] or t[1] not in self.models:
                    continue
                mid, fw = t[1], self.models[t[1]]
                ops = u["ops"]
                if u["via"] == "objects" and fw == "django":
                    write = any(o in DJANGO_WRITES for o in ops)
                    self.edge("writes-model" if write else "reads-model", u["src"], mid, f, u["line"])
                elif u["via"] == "query" and fw == "sqlalchemy":
                    write = any(o in ("delete", "update") for o in ops)
                    self.edge("writes-model" if write else "reads-model", u["src"], mid, f, u["line"])
                elif u["via"] == "sqla-core" and fw == "sqlalchemy":
                    self.edge("writes-model" if SQLA_CORE.get(ops[0]) else "reads-model", u["src"], mid, f, u["line"])
                elif u["via"] == "session" and fw == "sqlalchemy":
                    write = ops[0] in ("add", "add_all", "merge")
                    self.edge("writes-model" if write else "reads-model", u["src"], mid, f, u["line"], inferred=True)
                else:
                    continue
                self.bump(f"{fw}.ormUses")


def enrich(projects, fragments, res, files, config) -> Dict[str, Any]:
    e = Enricher(projects, fragments, res, files, config)
    e.run()
    frameworks = {p["root"]: sorted(e.evidence.get(p["root"], set())) for p in projects}
    warnings = [{"code": w["code"], "message": w["message"], "count": w["count"], **({"path": sorted(w["paths"])[0]} if w["paths"] else {})}
                for w in e.warnings.values()]
    return {"nodes": e.nodes, "edges": sorted(e.edges.values(), key=lambda x: x["id"]), "warnings": warnings,
            "stats": e.stats, "patches": e.patches, "frameworks": frameworks}
