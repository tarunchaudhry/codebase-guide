"""Language-level Python extraction (stdlib only, Python 3.9+).

Pass 1 (per file, cacheable): parse → *shape* (defs, classes, import bindings, module vars, __all__, star imports).
Pass 2 (per file): nodes + edges, resolving names through the global module index and other files' shapes.
A file's shape has no line numbers, so editing a function body never invalidates the files that import it.
"""
from __future__ import annotations

import ast
import builtins
import hashlib
import json
import os
import posixpath
import re
import warnings
from typing import Any, Dict, List, Optional, Set, Tuple

from . import SIDECAR_VERSION

BUILTINS = frozenset(dir(builtins))
_AST_INDEX = getattr(ast, "Index", None)  # Python 3.8 wrapper node; removed in 3.14
MAX_FILE_BYTES = 2 * 1024 * 1024
POOL_THRESHOLD = 200
MAX_HOPS = 12
OUTPUT_DIR = ".codebase-guide"

# Env readers by fully-qualified callee. Value: index of the name argument.
ENV_CALLS = {
    "os.getenv": 0, "os.environ.get": 0, "os.environ.setdefault": 0, "os.environ.pop": 0,
    "decouple.config": 0, "environs.Env": None,
}
ENV_SUBSCRIPTS = {"os.environ"}
ENV_OBJECT_FACTORIES = {"environ.Env", "environs.Env"}
SETTINGS_BASES = {"pydantic.BaseSettings", "pydantic_settings.BaseSettings"}


# ---------------------------------------------------------------- helpers

def sha1(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


def is_test(rel: str) -> bool:
    parts = rel.split("/")
    base = parts[-1]
    return (base.startswith("test_") or base.endswith("_test.py") or base == "conftest.py"
            or "tests" in parts[:-1] or "test" in parts[:-1])


def dirname(rel: str) -> str:
    d = posixpath.dirname(rel)
    return d if d else "."


def one_line(s: str, n: int = 240) -> str:
    t = " ".join(s.split())
    return t if len(t) <= n else t[: n - 1] + "…"


def dotted_of(expr: ast.AST) -> Optional[List[str]]:
    """a.b.c → ['a','b','c']; anything else → None."""
    parts: List[str] = []
    while isinstance(expr, ast.Attribute):
        parts.append(expr.attr)
        expr = expr.value
    if isinstance(expr, ast.Name):
        parts.append(expr.id)
        return parts[::-1]
    return None


def str_const(node: Optional[ast.AST]) -> Optional[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def complexity(node: ast.AST) -> int:
    c = 1
    for n in ast.walk(node):
        if isinstance(n, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.Assert)):
            c += 1
        elif isinstance(n, ast.BoolOp):
            c += len(n.values) - 1
        elif isinstance(n, ast.comprehension):
            c += 1 + len(n.ifs)
        elif type(n).__name__ == "match_case":
            c += 1
    return c


def signature(fn: ast.AST) -> str:
    assert isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
    args = ast.unparse(fn.args)
    ret = " -> " + ast.unparse(fn.returns) if fn.returns is not None else ""
    prefix = "async def " if isinstance(fn, ast.AsyncFunctionDef) else "def "
    return one_line(f"{prefix}{fn.name}({args}){ret}", 300)


def docstring(node: ast.AST) -> Optional[str]:
    try:
        d = ast.get_docstring(node)  # type: ignore[arg-type]
    except TypeError:
        return None
    if not d:
        return None
    return one_line(d.split("\n\n")[0], 500)


def top_level_statements(body: List[ast.stmt]):
    """Module/class body statements, descending into if/try/with blocks (not functions)."""
    for st in body:
        yield st, False
        if isinstance(st, ast.If):
            tc = is_type_checking(st.test)
            for sub, _ in top_level_statements(st.body):
                yield sub, tc
            for sub, inner_tc in top_level_statements(st.orelse):
                yield sub, inner_tc
        elif isinstance(st, ast.Try) or type(st).__name__ == "TryStar":
            blocks = [st.body, st.orelse, st.finalbody] + [h.body for h in st.handlers]  # type: ignore[attr-defined]
            for b in blocks:
                yield from top_level_statements(b)
        elif isinstance(st, (ast.With, ast.AsyncWith)):
            yield from top_level_statements(st.body)


def is_type_checking(test: ast.AST) -> bool:
    d = dotted_of(test)
    return bool(d) and d[-1] == "TYPE_CHECKING"


# ---------------------------------------------------------------- projects & module index

PROJECT_MARKERS = ("pyproject.toml", "setup.py", "setup.cfg", "manage.py")


def is_marker(rel: str) -> bool:
    base = rel.rsplit("/", 1)[-1]
    return base in PROJECT_MARKERS or bool(re.match(r"^requirements[\w.-]*\.txt$", base))


def read_toml_sections(text: str) -> Dict[str, List[Tuple[str, str, int]]]:
    """Minimal TOML reader: `[section]` → [(key, string value, line)]. Only simple `key = "value"` lines.
    One parser on every Python version keeps the output byte-identical (tomllib only exists on 3.11+)."""
    out: Dict[str, List[Tuple[str, str, int]]] = {}
    section = ""
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip() if not raw.strip().startswith(("'", '"')) else raw.strip()
        m = re.match(r"^\[\s*([^\[\]]+?)\s*\]$", line)
        if m:
            section = m.group(1)
            continue
        m = re.match(r"""^["']?([\w.-]+)["']?\s*=\s*(["'])(.*?)\2\s*$""", line)
        if m:
            out.setdefault(section, []).append((m.group(1), m.group(3), i))
    return out


def detect_projects(root: str, files: List[str]) -> List[Dict[str, Any]]:
    py = [f for f in files if f.endswith(".py")]
    roots = sorted({dirname(f) for f in files if is_marker(f)})
    if py and any(not any(r == "." or f.startswith(r + "/") for r in roots) for f in py):
        roots = sorted(set(roots) | {"."})
    by_depth = sorted(roots, key=lambda r: (-len(r), r))
    owned: Dict[str, List[str]] = {}
    for f in py:
        r = next((r for r in by_depth if r == "." or f.startswith(r + "/")), ".")
        owned.setdefault(r, []).append(f)
    projects = []
    for r in sorted(owned):
        pyproject = "pyproject.toml" if r == "." else f"{r}/pyproject.toml"
        name = posixpath.basename(root) if r == "." else posixpath.basename(r)
        scripts: List[Tuple[str, str, int]] = []
        if pyproject in files:
            try:
                with open(os.path.join(root, pyproject), encoding="utf-8") as fh:
                    sec = read_toml_sections(fh.read())
                for s in ("project", "tool.poetry"):
                    for k, v, _ in sec.get(s, []):
                        if k == "name":
                            name = v
                            break
                for s in ("project.scripts", "tool.poetry.scripts"):
                    scripts += sec.get(s, [])
            except (OSError, UnicodeDecodeError):
                pass
        src = r + "/src" if r != "." else "src"
        import_roots = [r]
        if any(f.startswith(src + "/") for f in owned[r]):
            import_roots.insert(0, src)
        projects.append({"root": r, "name": name, "files": sorted(owned[r]), "importRoots": import_roots,
                         "pyproject": pyproject if pyproject in files else None, "scripts": scripts})
    return projects


def module_name(rel: str, import_root: str) -> Optional[str]:
    prefix = "" if import_root == "." else import_root + "/"
    if not rel.startswith(prefix):
        return None
    parts = rel[len(prefix):][:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    if not parts or not all(p.isidentifier() for p in parts):
        return None
    return ".".join(parts)


def build_index(projects: List[Dict[str, Any]], extra_roots: List[str]) -> Tuple[Dict[str, str], Dict[str, str], Set[str]]:
    """dotted → rel, rel → dotted, and the set of internal namespace prefixes."""
    index: Dict[str, str] = {}
    names: Dict[str, str] = {}
    for p in projects:
        for f in p["files"]:
            for r in p["importRoots"] + list(extra_roots):
                m = module_name(f, r)
                if m is not None:
                    names.setdefault(f, m)
                    index.setdefault(m, f)
                    break
    prefixes: Set[str] = set()
    for m in index:
        parts = m.split(".")
        for i in range(1, len(parts)):
            prefixes.add(".".join(parts[:i]))
    return index, names, prefixes


# ---------------------------------------------------------------- pass 1: shapes

def absolute_module(cur_module: str, is_pkg: bool, level: int, module: Optional[str]) -> Optional[str]:
    if level == 0:
        return module
    pkg = cur_module.split(".") if is_pkg else cur_module.split(".")[:-1]
    if level - 1 > len(pkg):
        return None
    base = pkg[: len(pkg) - (level - 1)]
    if module:
        base = base + module.split(".")
    return ".".join(base) if base else None


def import_bindings(st: ast.stmt, cur_module: str, is_pkg: bool) -> Tuple[Dict[str, str], List[str], List[Tuple[str, Optional[str]]]]:
    """→ (name → dotted target, star-import modules, [(imported module dotted, imported name or None)])."""
    binds: Dict[str, str] = {}
    stars: List[str] = []
    targets: List[Tuple[str, Optional[str]]] = []
    if isinstance(st, ast.Import):
        for a in st.names:
            if a.asname:
                binds[a.asname] = a.name
            else:
                binds[a.name.split(".")[0]] = a.name.split(".")[0]
            targets.append((a.name, None))
    elif isinstance(st, ast.ImportFrom):
        mod = absolute_module(cur_module, is_pkg, st.level or 0, st.module)
        if mod is None:
            targets.append(("." * (st.level or 0) + (st.module or ""), None))
            return binds, stars, targets
        for a in st.names:
            if a.name == "*":
                stars.append(mod)
                targets.append((mod, None))
            else:
                binds[a.asname or a.name] = f"{mod}.{a.name}"
                targets.append((mod, a.name))
    return binds, stars, targets


def shape_of(tree: ast.Module, cur_module: str, is_pkg: bool) -> Dict[str, Any]:
    defs: Dict[str, str] = {}
    classes: Dict[str, Dict[str, Any]] = {}
    binds: Dict[str, str] = {}
    stars: List[str] = []
    variables: Set[str] = set()
    all_names: Optional[List[str]] = None
    for st, _tc in top_level_statements(tree.body):
        # Duplicate names (platform branches): the first definition owns the plain id, so the shape keeps the first too.
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defs.setdefault(st.name, "function")
        elif isinstance(st, ast.ClassDef):
            if st.name in defs:
                continue
            defs[st.name] = "class"
            methods = sorted({m.name for m, _ in top_level_statements(st.body) if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))})
            bases = [".".join(d) for d in (dotted_of(b) for b in st.bases) if d]
            classes[st.name] = {"methods": methods, "bases": bases}
        elif isinstance(st, (ast.Import, ast.ImportFrom)):
            b, s, _ = import_bindings(st, cur_module, is_pkg)
            binds.update(b)
            stars += s
        elif isinstance(st, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            tgts = st.targets if isinstance(st, ast.Assign) else [st.target]
            for t in tgts:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name):
                        variables.add(n.id)
                        if n.id == "__all__" and isinstance(st, ast.Assign) and isinstance(st.value, (ast.List, ast.Tuple)):
                            vals = [str_const(e) for e in st.value.elts]
                            if all(v is not None for v in vals):
                                all_names = [v for v in vals if v is not None]
    for name in list(variables):
        if name in defs or name in binds:
            variables.discard(name)
    return {"defs": defs, "classes": classes, "binds": binds, "stars": sorted(set(stars)),
            "vars": sorted(variables), "all": all_names}


def exported_names(shape: Dict[str, Any]) -> Set[str]:
    if shape["all"] is not None:
        return set(shape["all"])
    return {n for n in list(shape["defs"]) + list(shape["binds"]) + shape["vars"] if not n.startswith("_")}


# ---------------------------------------------------------------- resolution (global state set per process)

class Resolver:
    def __init__(self, index: Dict[str, str], names: Dict[str, str], prefixes: Set[str], shapes: Dict[str, Dict[str, Any]]):
        self.index, self.names, self.prefixes, self.shapes = index, names, prefixes, shapes

    def module_of(self, dotted: str) -> Tuple[Optional[str], List[str]]:
        parts = dotted.split(".")
        for i in range(len(parts), 0, -1):
            rel = self.index.get(".".join(parts[:i]))
            if rel is not None:
                return rel, parts[i:]
        return None, parts

    def is_internal_root(self, dotted: str) -> bool:
        head = dotted.split(".")[0]
        return head in self.index or head in self.prefixes

    def resolve(self, dotted: str, hops: int = 0) -> Tuple[str, Optional[str]]:
        """→ ('node', id) | ('module', rel) | ('external', dotted) | ('dynamic', None) | ('unresolved', None)."""
        if hops > MAX_HOPS:
            return "unresolved", None
        rel, rest = self.module_of(dotted)
        if rel is None:
            return ("unresolved", None) if self.is_internal_root(dotted) else ("external", dotted)
        if not rest:
            return "module", rel
        return self.resolve_in(rel, rest, hops)

    def resolve_in(self, rel: str, rest: List[str], hops: int = 0) -> Tuple[str, Optional[str]]:
        shape = self.shapes.get(rel)
        if shape is None:
            return "unresolved", None
        name, tail = rest[0], rest[1:]
        kind = shape["defs"].get(name)
        if kind == "function":
            return ("node", node_id("function", rel, name)) if not tail else ("dynamic", None)
        if kind == "class":
            if not tail:
                return "node", node_id("class", rel, name)
            if len(tail) == 1:
                m = self.method_of(rel, name, tail[0], hops)
                return ("node", m) if m else ("dynamic", None)
            return "dynamic", None
        if name in shape["binds"]:
            return self.resolve(".".join([shape["binds"][name]] + tail), hops + 1)
        if name in shape["vars"]:
            return "dynamic", None
        for star in shape["stars"]:
            srel, srest = self.module_of(star)
            if srel is not None and not srest and name in exported_names(self.shapes.get(srel, {"defs": {}, "binds": {}, "vars": [], "all": None})):
                return self.resolve(".".join([star, name] + tail), hops + 1)
        if self.has_external_star(shape):
            return "external-star", None
        return "unresolved", None

    def has_external_star(self, shape: Dict[str, Any]) -> bool:
        """`from posix import *` / `from _struct import *`: a missing name most likely comes from there."""
        return any(self.module_of(s)[0] is None and not self.is_internal_root(s) for s in shape["stars"])

    def class_ref(self, rel: str, base: str, hops: int) -> Optional[Tuple[str, str]]:
        """Resolve a base-class expression written in module `rel` to (rel, class name)."""
        shape = self.shapes.get(rel)
        if shape is None:
            return None
        head, *tail = base.split(".")
        if head in shape["defs"] and not tail:
            return (rel, head) if shape["defs"][head] == "class" else None
        target = shape["binds"].get(head)
        if target is None:
            return None
        kind, ref = self.resolve(".".join([target] + tail), hops + 1)
        if kind == "node" and ref and ref.startswith("py:class:"):
            r, _, n = ref[len("py:class:"):].partition("#")
            return r, n
        return None

    def method_of(self, rel: str, cls: str, method: str, hops: int = 0) -> Optional[str]:
        """Method lookup through internal base classes (depth-first, declaration order)."""
        seen: Set[Tuple[str, str]] = set()
        stack = [(rel, cls)]
        while stack and hops <= MAX_HOPS:
            r, c = stack.pop(0)
            if (r, c) in seen:
                continue
            seen.add((r, c))
            info = self.shapes.get(r, {}).get("classes", {}).get(c)
            if info is None:
                continue
            if method in info["methods"]:
                return node_id("method", r, f"{c}.{method}")
            for b in info["bases"]:
                ref = self.class_ref(r, b, hops)
                if ref:
                    stack.append(ref)
            hops += 1
        return None


def node_id(kind: str, rel: str, qual: Optional[str] = None) -> str:
    return f"py:{kind}:{rel}" + (f"#{qual}" if qual else "")


# ---------------------------------------------------------------- pass 2: nodes and edges

class FileExtractor:
    def __init__(self, rel: str, tree: ast.Module, shape: Dict[str, Any], res: Resolver, project_root: str):
        self.rel, self.tree, self.shape, self.res, self.project_root = rel, tree, shape, res, project_root
        self.mod = res.names.get(rel, "")
        self.is_pkg = rel.endswith("__init__.py")
        self.mod_id = node_id("module", rel)
        self.nodes: List[Dict[str, Any]] = []
        self.edges: Dict[str, Dict[str, Any]] = {}
        self.warnings: Dict[str, Dict[str, Any]] = {}
        self.stats: Dict[str, int] = {}
        self.imports: Set[str] = set()
        self.test = is_test(rel)
        self.env_objects: Set[str] = set()
        self.env_defaults: Dict[str, str] = {}
        self.scopes: Dict[int, Tuple[Dict[str, str], Set[str]]] = {}
        self.exported = exported_names(shape)

    # -- output helpers
    def bump(self, k: str, n: int = 1) -> None:
        self.stats[k] = self.stats.get(k, 0) + n

    def warn(self, code: str, message: str) -> None:
        w = self.warnings.setdefault(code, {"code": code, "message": message, "count": 0, "path": self.rel})
        w["count"] += 1

    def edge(self, kind: str, src: str, dst: str, line: int, inferred: bool = False) -> None:
        eid = f"{kind}:{src}->{dst}"
        e = self.edges.get(eid)
        ev = {"path": self.rel, "line": line}
        if e is None:
            e = {"id": eid, "source": src, "target": dst, "kind": kind, "weight": 0, "evidence": []}
            if inferred:
                e["inferred"] = True
            self.edges[eid] = e
        e["weight"] += 1
        if ev not in e["evidence"]:
            e["evidence"] = sorted(e["evidence"] + [ev], key=lambda x: (x["path"], x["line"]))[:5]

    def env(self, name: str, src: str, line: int, inferred: bool = False) -> None:
        nid = f"config:env-var:{name}"
        if not any(n["id"] == nid for n in self.nodes):
            self.nodes.append({"id": nid, "kind": "env-var", "label": name, "parent": None, "level": 3, "lang": "config", "meta": {}})
        self.edge("reads-env", src, nid, line, inferred)

    # -- main
    def run(self) -> Dict[str, Any]:
        exported_defs = [n for n in self.shape["defs"] if n in self.exported]
        self.nodes.append({
            "id": self.mod_id, "kind": "module", "label": posixpath.basename(self.rel), "parent": node_id("module-group", dirname(self.rel)),
            "level": 2, "lang": "py", "path": self.rel, "line": 1, "endLine": max(1, getattr(self.tree, "_cg_lines", 1)),
            "meta": {k: v for k, v in {"loc": getattr(self.tree, "_cg_loc", 0), "exportsCount": len(exported_defs),
                                       "doc": docstring(self.tree), "role": "test" if self.test else None}.items() if v is not None},
        })
        self.symbol_nodes()
        self.walk_imports(self.tree.body, toplevel=True)
        self.walk_body()
        from .frameworks import collect
        facts = collect(self)
        return {**({"facts": facts} if facts else {}), "nodes": self.nodes, "edges": sorted(self.edges.values(), key=lambda e: e["id"]),
                "warnings": sorted(self.warnings.values(), key=lambda w: w["code"]), "stats": self.stats,
                "imports": sorted(self.imports)}

    def symbol_nodes(self) -> None:
        seen: Dict[str, int] = {}

        def qual(name: str) -> str:
            seen[name] = seen.get(name, 0) + 1
            return name if seen[name] == 1 else f"{name}~{seen[name]}"

        self.def_ids: List[Tuple[ast.AST, str, Optional[str]]] = []  # (node, id, class qualname for methods)
        self.own_methods: Dict[str, Set[str]] = {}
        for st, _ in top_level_statements(self.tree.body):
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                q = qual(st.name)
                self.add_symbol("function", q, st, st.name in self.exported and q == st.name, self.mod_id)
            elif isinstance(st, ast.ClassDef):
                q = qual(st.name)
                cid = self.add_symbol("class", q, st, st.name in self.exported and q == st.name, self.mod_id)
                mseen: Set[str] = set()
                self.own_methods[q] = mseen
                for m, _ in top_level_statements(st.body):
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name not in mseen:
                        mseen.add(m.name)
                        self.add_symbol("method", f"{q}.{m.name}", m, st.name in self.exported and not m.name.startswith("_"), cid, cls=q)

    def add_symbol(self, kind: str, q: str, st: Any, exported: bool, parent: str, cls: Optional[str] = None) -> str:
        nid = node_id(kind, self.rel, q)
        meta: Dict[str, Any] = {"loc": (st.end_lineno or st.lineno) - st.lineno + 1}
        if kind != "class":
            meta["signature"] = signature(st)
            meta["complexity"] = complexity(st)
        else:
            bases = [one_line(ast.unparse(b), 120) for b in st.bases]
            if bases:
                meta["signature"] = one_line(f"class {st.name}({', '.join(bases)})", 300)
        doc = docstring(st)
        if doc:
            meta["doc"] = doc
        decos = [self.decorator_name(d) for d in st.decorator_list]
        decos = [d for d in decos if d]
        if decos:
            meta["decorators"] = decos
        if exported:
            meta["exported"] = True
        if self.test:
            meta["role"] = "test"
        self.nodes.append({"id": nid, "kind": kind, "label": q, "parent": parent, "level": 3, "lang": "py",
                           "path": self.rel, "line": st.lineno, "endLine": st.end_lineno or st.lineno, "meta": meta})
        self.def_ids.append((st, nid, cls))
        return nid

    def decorator_name(self, d: ast.AST) -> Optional[str]:
        target = d.func if isinstance(d, ast.Call) else d
        parts = dotted_of(target)
        if not parts:
            return None
        head = self.shape["binds"].get(parts[0])
        return ".".join([head] + parts[1:]) if head else ".".join(parts)

    # -- imports
    def walk_imports(self, body: List[ast.stmt], toplevel: bool) -> None:
        stmts = top_level_statements(body) if toplevel else ((n, False) for n in ast.walk(ast.Module(body=body, type_ignores=[])))
        for st, tc in stmts:
            if not isinstance(st, (ast.Import, ast.ImportFrom)):
                continue
            if tc:
                self.bump("py.typeCheckingImports")
                continue
            _, _, targets = import_bindings(st, self.mod, self.is_pkg)
            for mod, name in targets:
                self.import_edge(st, mod, name)

    def import_edge(self, st: ast.stmt, mod: str, name: Optional[str]) -> None:
        if mod.startswith("."):
            self.warn("py-unresolved-import", "Relative imports that could not be resolved")
            return
        target = None
        if name is not None and (mod + "." + name) in self.res.index:
            target = self.res.index[mod + "." + name]
        else:
            rel, rest = self.res.module_of(mod)
            if rel is not None and not rest:
                target = rel
            elif rel is not None:
                target = rel  # `import a.b.c` where only a.b is a module: still a dependency on a.b
        if target is None:
            if self.res.is_internal_root(mod) or isinstance(st, ast.ImportFrom) and st.level:
                self.warn("py-unresolved-import", "Internal-looking imports that could not be resolved")
            else:
                self.bump("py.externalImports")
            return
        if target == self.rel:
            return
        self.imports.add(target)
        tid = node_id("module", target)
        self.edge("imports", self.mod_id, tid, st.lineno)
        if self.test and not is_test(target):
            self.edge("tests", self.mod_id, tid, st.lineno)

    # -- bodies: calls and env reads
    def walk_body(self) -> None:
        owned: Set[int] = set()
        for st, nid, cls in self.def_ids:
            if isinstance(st, ast.ClassDef):
                continue
            owned.add(id(st))
            self.scopes[id(st)] = self.local_scope(st)
            self.walk_scope(st, nid, cls, self.scopes[id(st)])
        for st, nid, _ in self.def_ids:
            if isinstance(st, ast.ClassDef):
                for sub in st.body:
                    if not isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        self.walk_scope(sub, nid, None, ({}, set()))
                for b in st.bases:
                    parts = dotted_of(b)
                    full = self.qualify(parts) if parts else None
                    if full in SETTINGS_BASES:
                        self.settings_env(st, nid)
        for st, _tc in top_level_statements(self.tree.body):
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) or id(st) in owned:
                continue
            if isinstance(st, (ast.If, ast.Try, ast.With, ast.AsyncWith)) or type(st).__name__ == "TryStar":
                # bodies were yielded separately by top_level_statements; only scan the header expressions
                for hdr in [getattr(st, "test", None)] + [i.context_expr for i in getattr(st, "items", [])]:
                    if hdr is not None:
                        self.walk_scope(hdr, self.mod_id, None, ({}, set()))
                continue
            self.track_env_objects(st)
            self.walk_scope(st, self.mod_id, None, ({}, set()))

    def local_scope(self, fn: ast.AST) -> Tuple[Dict[str, str], Set[str]]:
        """(function-local import bindings, other local names). Locals shadow module names; never guessed."""
        binds: Dict[str, str] = {}
        local: Set[str] = set()
        for n in ast.walk(fn):
            if isinstance(n, (ast.Import, ast.ImportFrom)):
                b, _, _ = import_bindings(n, self.mod, self.is_pkg)
                binds.update(b)
            elif isinstance(n, ast.arg):
                local.add(n.arg)
            elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
                local.add(n.id)
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n is not fn:
                local.add(n.name)
            elif isinstance(n, (ast.Global, ast.Nonlocal)):
                local.difference_update(n.names)
        local.difference_update(binds)
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.walk_imports(fn.body, toplevel=False)
        return binds, local

    def qualify(self, parts: List[str], scope: Tuple[Dict[str, str], Set[str]] = ({}, set())) -> Optional[str]:
        """Fully-qualified dotted name for an expression like os.environ.get, or None if it starts at a local."""
        binds, local = scope
        head = parts[0]
        if head in local:
            return None
        if head in binds:
            return ".".join([binds[head]] + parts[1:])
        if head in self.shape["binds"]:
            return ".".join([self.shape["binds"][head]] + parts[1:])
        if (head in self.shape["defs"] or head in self.shape["vars"]) and self.mod:
            return ".".join([self.mod, head] + parts[1:])
        return None

    def track_env_objects(self, st: ast.stmt) -> None:
        if isinstance(st, ast.Assign) and isinstance(st.value, ast.Call):
            parts = dotted_of(st.value.func)
            if parts and self.qualify(parts) in ENV_OBJECT_FACTORIES:
                for t in st.targets:
                    if isinstance(t, ast.Name):
                        self.env_objects.add(t.id)

    def walk_scope(self, node: ast.AST, src: str, cls: Optional[str], scope: Tuple[Dict[str, str], Set[str]]) -> None:
        for n in ast.walk(node):
            if isinstance(n, ast.Call):
                self.env_call(n, src, scope)
                self.call(n, src, cls, scope)
            elif isinstance(n, ast.Subscript) and isinstance(n.ctx, ast.Load):
                parts = dotted_of(n.value)
                if parts and self.qualify(parts, scope) in ENV_SUBSCRIPTS:
                    sl = n.slice.value if _AST_INDEX is not None and isinstance(n.slice, _AST_INDEX) else n.slice  # type: ignore[attr-defined]
                    key = str_const(sl)
                    if key:
                        self.env(key, src, n.lineno)
                    else:
                        self.warn("py-dynamic-env", "os.environ[...] with a non-literal key (name unknown)")

    def env_call(self, n: ast.Call, src: str, scope: Tuple[Dict[str, str], Set[str]]) -> None:
        parts = dotted_of(n.func)
        if not parts:
            return
        full = self.qualify(parts, scope)
        is_env_obj = parts[0] in self.env_objects and parts[0] not in scope[1] and len(parts) <= 2
        if (full in ENV_CALLS and ENV_CALLS[full] is not None) or is_env_obj:
            key = str_const(n.args[0]) if n.args else None
            if key is None:
                for kw in n.keywords:
                    if kw.arg in ("key", "var"):
                        key = str_const(kw.value)
            if key:
                self.env(key, src, n.lineno)
                if full == "os.environ.setdefault" and len(n.args) > 1 and str_const(n.args[1]) is not None:
                    self.env_defaults.setdefault(key, str_const(n.args[1]) or "")
            elif not (is_env_obj and len(parts) == 2 and parts[1] in ("read_env", "smart_cast", "parse_value")):
                self.warn("py-dynamic-env", "Env reads with a non-literal name (name unknown)")

    def settings_env(self, cls: ast.ClassDef, cid: str) -> None:
        """pydantic BaseSettings fields map to env vars (case-insensitive, optional prefix). Always inferred."""
        prefix = ""
        for st in cls.body:
            if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "model_config" for t in st.targets) and isinstance(st.value, ast.Call):
                for kw in st.value.keywords:
                    if kw.arg == "env_prefix" and str_const(kw.value) is not None:
                        prefix = str_const(kw.value) or ""
            if isinstance(st, ast.ClassDef) and st.name == "Config":
                for s in st.body:
                    if isinstance(s, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "env_prefix" for t in s.targets):
                        prefix = str_const(s.value) or prefix
        for st in cls.body:
            if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.target.id != "model_config":
                ann = ast.unparse(st.annotation)
                if ann.startswith(("ClassVar", "typing.ClassVar")):
                    continue
                name = (prefix + st.target.id).upper()
                if isinstance(st.value, ast.Call):
                    for kw in st.value.keywords:
                        if kw.arg in ("env", "validation_alias", "alias") and str_const(kw.value):
                            name = str_const(kw.value) or name
                self.env(name, cid, st.lineno, inferred=True)

    def class_bases(self, cls_qual: str) -> List[str]:
        for st, nid, c in self.def_ids:
            if c is None and isinstance(st, ast.ClassDef) and nid == node_id("class", self.rel, cls_qual):
                return [".".join(d) for d in (dotted_of(b) for b in st.bases) if d]
        return []

    def call(self, n: ast.Call, src: str, cls: Optional[str], scope: Tuple[Dict[str, str], Set[str]]) -> None:
        binds, local = scope
        f = n.func
        target: Optional[str] = None
        kind = "unresolved"
        # super().m()
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Call) and isinstance(f.value.func, ast.Name) and f.value.func.id == "super":
            if cls:
                for b in self.class_bases(cls):
                    ref = self.res.class_ref(self.rel, b, 0)
                    m = self.res.method_of(ref[0], ref[1], f.attr) if ref else None
                    if m:
                        target = m
                        break
            kind = "node" if target else "dynamic"
        else:
            parts = dotted_of(f)
            if not parts:
                kind = "dynamic"
            elif parts[0] in ("self", "cls") and cls and parts[0] in local:
                if len(parts) == 2 and parts[1] in self.own_methods.get(cls, set()):
                    target = node_id("method", self.rel, f"{cls}.{parts[1]}")
                elif len(parts) == 2:
                    for b in self.class_bases(cls):
                        ref = self.res.class_ref(self.rel, b, 0)
                        target = self.res.method_of(ref[0], ref[1], parts[1]) if ref else None
                        if target:
                            break
                kind = "node" if target else "dynamic"
            elif parts[0] in local:
                kind = "dynamic"
            elif parts[0] in binds or parts[0] in self.shape["binds"] or parts[0] in self.shape["defs"] or parts[0] in self.shape["vars"]:
                if parts[0] in self.shape["vars"] and parts[0] not in binds:
                    kind = "dynamic"
                elif parts[0] in self.shape["defs"] and parts[0] not in binds:
                    kind, ref = self.res.resolve_in(self.rel, parts)
                    target = ref if kind == "node" else None
                else:
                    full = self.qualify(parts, scope)
                    kind, ref = self.res.resolve(full) if full else ("unresolved", None)
                    if kind == "node":
                        target = ref
                    elif kind == "module":
                        kind = "dynamic"
            else:
                star_hit = None
                for star in self.shape["stars"]:
                    srel, srest = self.res.module_of(star)
                    if srel is not None and not srest and parts[0] in exported_names(self.res.shapes.get(srel, {"defs": {}, "binds": {}, "vars": [], "all": None})):
                        star_hit = star
                        break
                if star_hit:
                    kind, ref = self.res.resolve(".".join([star_hit] + parts))
                    target = ref if kind == "node" else None
                elif parts[0] in BUILTINS:
                    kind = "external"
                elif self.res.has_external_star(self.shape):
                    kind = "external-star"
                else:
                    kind = "unresolved"
        if kind == "node" and target:
            if target != src:
                self.edge("calls", src, target, n.lineno)
            self.bump("py.callsResolved")
        elif kind == "external":
            self.bump("py.callsExternal")
        elif kind == "external-star":
            self.bump("py.callsViaExternalStarImport")
        elif kind == "dynamic":
            self.bump("py.callsDynamic")
        else:
            self.bump("py.callsUnresolved")
            self.warn("py-unresolved-call", "Calls dropped: name not bound by any import or definition (star import from a package, or generated code)")


# ---------------------------------------------------------------- orchestration (per-file workers)

_STATE: Dict[str, Any] = {}


def _init_worker(root: str, index: Dict[str, str], names: Dict[str, str], prefixes: Set[str], shapes: Dict[str, Dict[str, Any]], owner: Dict[str, str],
                 api_clients: Optional[List[str]] = None) -> None:
    _STATE["root"] = root
    _STATE["api_clients"] = api_clients or []
    _STATE["res"] = Resolver(index, names, prefixes, shapes)
    _STATE["owner"] = owner


def parse_file(root: str, rel: str) -> Tuple[Optional[ast.Module], Optional[str]]:
    try:
        with open(os.path.join(root, rel), "rb") as fh:
            data = fh.read()
    except OSError as e:
        return None, f"unreadable: {e.strerror}"
    if len(data) > MAX_FILE_BYTES:
        return None, "too-large"
    try:
        with warnings.catch_warnings():
            # SyntaxWarnings (e.g. invalid escapes) are about the target's code, not ours; they'd also differ cold vs warm.
            warnings.simplefilter("ignore")
            tree = ast.parse(data, filename=rel)
    except (SyntaxError, ValueError) as e:
        return None, f"syntax error line {getattr(e, 'lineno', '?')}"
    text = data.decode("utf-8", "replace")
    tree._cg_loc = sum(1 for l in text.splitlines() if l.strip())  # type: ignore[attr-defined]
    tree._cg_lines = max(1, len(text.splitlines()))  # type: ignore[attr-defined]
    return tree, None


def _shape_job(args: Tuple[str, str, str, bool]) -> Tuple[str, Optional[Dict[str, Any]], Optional[str]]:
    root, rel, mod, is_pkg = args
    tree, err = parse_file(root, rel)
    if tree is None:
        return rel, None, err
    return rel, shape_of(tree, mod, is_pkg), None


def _fragment_job(rel: str) -> Tuple[str, Optional[Dict[str, Any]], Optional[str]]:
    res: Resolver = _STATE["res"]
    tree, err = parse_file(_STATE["root"], rel)
    if tree is None:
        return rel, None, err
    try:
        fx = FileExtractor(rel, tree, res.shapes[rel], res, _STATE["owner"][rel])
        fx.api_clients = _STATE.get("api_clients", [])
        frag = fx.run()
    except RecursionError:
        return rel, None, "recursion limit"
    return rel, frag, None


def _map(fn, items, workers: int, init_args=None):
    if workers > 1 and len(items) > POOL_THRESHOLD:
        import multiprocessing as mp
        ctx = mp.get_context("spawn")
        with ctx.Pool(workers, initializer=_init_worker if init_args else None, initargs=init_args or ()) as pool:
            return pool.map(fn, items, chunksize=max(1, len(items) // (workers * 4)))
    if init_args:
        _init_worker(*init_args)
    return [fn(i) for i in items]


def extract(root: str, files: List[str], python_path: List[str], use_cache: bool = True, workers: Optional[int] = None,
            django_settings: Optional[str] = None, api_clients: Optional[List[str]] = None) -> Dict[str, Any]:
    root = os.path.realpath(root)
    files = sorted(set(files))
    projects = detect_projects(root, files)
    index, names, prefixes = build_index(projects, python_path)
    owner = {f: p["root"] for p in projects for f in p["files"]}
    py_files = sorted(owner)
    workers = workers if workers is not None else min(8, os.cpu_count() or 1)

    cache_path = os.path.join(root, OUTPUT_DIR, "cache", "py-extract.json")
    key = sha1(json.dumps([SIDECAR_VERSION, python_path, [(p["root"], p["importRoots"]) for p in projects], api_clients or []], sort_keys=True).encode())
    cache: Dict[str, Any] = {}
    if use_cache:
        try:
            with open(cache_path, encoding="utf-8") as fh:
                c = json.load(fh)
            if c.get("key") == key:
                cache = c.get("files", {})
        except (OSError, ValueError):
            pass

    hashes: Dict[str, str] = {}
    for f in py_files:
        try:
            with open(os.path.join(root, f), "rb") as fh:
                hashes[f] = sha1(fh.read())
        except OSError:
            hashes[f] = ""

    warnings: Dict[str, Dict[str, Any]] = {}

    def warn(code: str, message: str, path: Optional[str] = None) -> None:
        w = warnings.setdefault(code, {"code": code, "message": message, "count": 0, "paths": []})
        w["count"] += 1
        if path:
            w["paths"].append(path)

    # Pass 1: shapes (cached by content hash).
    shapes: Dict[str, Dict[str, Any]] = {}
    errors: Dict[str, str] = {}
    todo = []
    for f in py_files:
        entry = cache.get(f)
        if entry and entry.get("hash") == hashes[f] and (entry.get("shape") is not None or entry.get("error")):
            if entry.get("error"):
                errors[f] = entry["error"]
            else:
                shapes[f] = entry["shape"]
        else:
            todo.append((root, f, names.get(f, ""), f.endswith("__init__.py")))
    for rel, shape, err in _map(_shape_job, todo, workers):
        if shape is None:
            errors[rel] = err or "error"
        else:
            shapes[rel] = shape

    # Dirty set: content changed; plus importers (transitively) of files whose *shape* changed.
    file_set_changed = sorted(cache) != py_files
    changed = {f for f in py_files if cache.get(f, {}).get("hash") != hashes[f]}
    shape_changed = {f for f in changed if cache.get(f, {}).get("shape") != shapes.get(f)}
    shape_changed |= {f for f in cache if f not in owner}
    importers: Dict[str, List[str]] = {}
    for f, entry in cache.items():
        for t in (entry.get("fragment") or {}).get("imports", []):
            importers.setdefault(t, []).append(f)
    dirty = set(changed)
    work = list(shape_changed)
    seen = set(work)
    while work:
        f = work.pop()
        for imp in importers.get(f, []):
            if imp in owner:
                dirty.add(imp)
                if imp not in seen:
                    seen.add(imp)
                    work.append(imp)
    if file_set_changed:
        dirty = set(py_files)
    dirty = {f for f in dirty if f in shapes}

    fragments: Dict[str, Dict[str, Any]] = {}
    reused = 0
    for f in py_files:
        if f in shapes and f not in dirty and cache.get(f, {}).get("fragment"):
            fragments[f] = cache[f]["fragment"]
            reused += 1
        elif f in shapes:
            dirty.add(f)
    init_args = (root, index, names, prefixes, shapes, owner, api_clients or [])
    for rel, frag, err in _map(_fragment_job, sorted(dirty), workers, init_args):
        if frag is None:
            errors[rel] = err or "error"
        else:
            fragments[rel] = frag

    for f in sorted(errors):
        if errors[f].startswith("syntax error"):
            warn("py-syntax-error", "Python files skipped because they do not parse", f)
        elif errors[f] == "too-large":
            warn("py-file-too-large", "Python files larger than 2 MB skipped", f)
        else:
            warn("py-file-failed", "Python files that failed to extract", f)

    if True:  # the cache is always rewritten; use_cache=False only skips reading it
        new_cache = {"key": key, "files": {f: {"hash": hashes[f], "shape": shapes.get(f), "error": errors.get(f), "fragment": fragments.get(f)} for f in py_files}}
        try:
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, "w", encoding="utf-8") as fh:
                json.dump(new_cache, fh, sort_keys=True, separators=(",", ":"))
        except OSError:
            warn("py-cache-write-failed", "Could not write the Python extraction cache")

    # Structural nodes: project → module-group(s).
    nodes: List[Dict[str, Any]] = []
    for p in projects:
        pid = node_id("project", p["root"])
        nodes.append({"id": pid, "kind": "project", "label": p["name"], "parent": None, "level": 0, "lang": "py", "path": p["root"], "meta": {}})
        groups: Set[str] = set()
        for f in p["files"]:
            d = dirname(f)
            while d not in groups:
                groups.add(d)
                if d == p["root"]:
                    break
                d = dirname(d)
        for g in sorted(groups):
            parent = pid if g == p["root"] else node_id("module-group", dirname(g))
            nodes.append({"id": node_id("module-group", g), "kind": "module-group", "label": p["name"] if g == p["root"] else posixpath.basename(g),
                          "parent": parent, "level": 1, "lang": "py", "path": g, "meta": {}})
        for name, cmd, line in p["scripts"]:
            nodes.append({"id": f"config:script:{p['pyproject']}#{name}", "kind": "script", "label": name, "parent": pid, "level": 3,
                          "lang": "config", "path": p["pyproject"], "line": line, "meta": {"signature": cmd, "role": "pyproject-script"}})

    for f in sorted(errors):  # keep a bare module node so imports of an unparseable file still land somewhere
        nodes.append({"id": node_id("module", f), "kind": "module", "label": posixpath.basename(f), "parent": node_id("module-group", dirname(f)),
                      "level": 2, "lang": "py", "path": f, "line": 1, "meta": {"role": "test"} if is_test(f) else {}})
    edges: List[Dict[str, Any]] = []
    stats: Dict[str, int] = {}
    file_warnings: List[Dict[str, Any]] = []
    for f in sorted(fragments):
        fr = fragments[f]
        nodes += fr["nodes"]
        edges += fr["edges"]
        file_warnings += fr["warnings"]
        for k, v in fr["stats"].items():
            stats[k] = stats.get(k, 0) + v

    # Framework pass (AST-free, over cached facts): endpoints, mounts, chains, models, roles.
    from .frameworks import enrich
    fw = enrich(projects, fragments, Resolver(index, names, prefixes, shapes), files, {"djangoSettings": django_settings} if django_settings else {})
    nodes = [({**n, "meta": {**n["meta"], **fw["patches"][n["id"]]}} if n["id"] in fw["patches"] else n) for n in nodes] + fw["nodes"]
    edges += fw["edges"]
    file_warnings += fw["warnings"]
    for k, v in fw["stats"].items():
        stats[k] = stats.get(k, 0) + v
    out_warnings = [{"code": w["code"], "message": w["message"], "count": w["count"], **({"path": sorted(w["paths"])[0]} if w["paths"] else {})}
                    for w in warnings.values()] + file_warnings
    return {
        "projects": [{"id": node_id("project", p["root"]), "lang": "py", "frameworks": fw["frameworks"].get(p["root"], []), "root": p["root"]} for p in projects],
        "nodes": nodes, "edges": edges, "warnings": out_warnings, "stats": stats,
        "outbound": [{**h, "file": f} for f in sorted(fragments) for h in ((fragments[f].get("facts") or {}).get("http") or [])],
        "run": {"parsed": sorted(dirty), "cached": reused, "pythonFiles": len(py_files)},
    }
