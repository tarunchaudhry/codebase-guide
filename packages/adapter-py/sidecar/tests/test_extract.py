"""Run from packages/adapter-py/sidecar:  python3 -m unittest discover -s tests"""
import json
import os
import shutil
import tempfile
import unittest

from codebase_guide_sidecar import extract as ex

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "fixtures")


def copy_fixture(name):
    d = tempfile.mkdtemp(prefix=f"cg-{name}-")
    shutil.copytree(os.path.join(FIXTURES, name), d, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".codebase-guide"))
    return d


def file_list(root):
    out = []
    for d, dirs, fs in os.walk(root):
        dirs[:] = [x for x in dirs if x != ".codebase-guide"]
        out += [os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/") for f in fs if f != ".env"]
    return sorted(out)


def run(root, **kw):
    return ex.extract(root, file_list(root), [], **kw)


def short(i):
    return i.split(":", 2)[2]


def edges(out, kind):
    return sorted(f"{short(e['source'])} -> {short(e['target'])}" for e in out["edges"] if e["kind"] == kind)


class FixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = run(copy_fixture("py-basic"), use_cache=False)

    def test_calls(self):
        self.assertEqual(edges(self.out, "calls"), sorted([
            "src/shop/cli.py#main -> src/shop/services/orders.py#create_order",
            "src/shop/cli.py -> src/shop/cli.py#main",
            "src/shop/compat.py#Lock.acquire -> src/shop/compat.py#Lock._raw",          # duplicate class names in if/else
            "src/shop/compat.py#Lock~2.acquire -> src/shop/compat.py#Lock~2._raw",
            "src/shop/models.py#Base.save -> src/shop/models.py#Base.validate",          # self.method()
            "src/shop/models.py#Order.submit -> src/shop/models.py#Base.save",          # inherited via internal base
            "src/shop/models.py#Order.submit -> src/shop/notify.py#notify",
            "src/shop/notify.py#notify -> src/shop/notify.py#send",
            "src/shop/services/orders.py#create_order -> src/shop/models.py#Order",     # re-export via shop/__init__
            "src/shop/services/orders.py#create_order -> src/shop/models.py#Item",      # import shop.models; shop.models.Item()
            "src/shop/services/orders.py#create_order -> src/shop/notify.py#send",      # from … import send as push
            "src/shop/services/orders.py#create_order -> src/shop/services/helpers.py#helper_fn",  # star import
            "src/shop/services/orders.py#late -> src/shop/notify.py#notify",            # function-local relative import
            "tests/test_orders.py#test_create -> src/shop/services/orders.py#create_order",
        ]))

    def test_dynamic_not_guessed(self):
        # order.submit() (local var) and shadow(send) → send() (param shadows the import) are dropped, not linked
        self.assertNotIn("src/shop/services/orders.py#shadow -> src/shop/notify.py#send", edges(self.out, "calls"))
        self.assertGreaterEqual(self.out["stats"]["py.callsDynamic"], 2)

    def test_imports_and_type_checking(self):
        imps = edges(self.out, "imports")
        self.assertIn("src/shop/services/orders.py -> src/shop/__init__.py", imps)
        self.assertNotIn("src/shop/notify.py -> src/shop/models.py", imps)  # TYPE_CHECKING-only
        self.assertEqual(self.out["stats"]["py.typeCheckingImports"], 1)
        self.assertEqual(edges(self.out, "tests"), ["tests/test_orders.py -> src/shop/services/orders.py"])

    def test_env(self):
        env = {(short(e["source"]), e["target"].split(":")[-1], bool(e.get("inferred"))) for e in self.out["edges"] if e["kind"] == "reads-env"}
        self.assertEqual(env, {
            ("src/shop/notify.py", "WEBHOOK_URL", False),
            ("src/shop/notify.py#notify", "NOTIFY_TOKEN", False),
            ("src/shop/settings.py", "DEBUG", False),
            ("src/shop/settings.py", "SECRET_KEY", False),
            ("src/shop/settings.py", "REDIS_URL", False),
            ("src/shop/settings.py#Settings", "SHOP_DB_URL", True),
        })

    def test_symbols_and_warnings(self):
        by_id = {n["id"]: n for n in self.out["nodes"]}
        n = by_id["py:function:src/shop/notify.py#notify"]
        self.assertEqual(n["meta"]["signature"], "def notify(order: 'Order') -> bool")
        self.assertEqual(n["meta"]["doc"], "Send an order notification.")
        self.assertTrue(n["meta"]["exported"])
        self.assertNotIn("exported", by_id["py:function:src/shop/services/helpers.py#_private"]["meta"])
        self.assertEqual(by_id["py:class:src/shop/models.py#Order"]["meta"]["signature"], "class Order(Base)")
        self.assertIn("py:module:src/shop/broken.py", by_id)
        self.assertEqual([w["code"] for w in self.out["warnings"]], ["py-syntax-error"])
        self.assertEqual([n["label"] for n in self.out["nodes"] if n["kind"] == "script"], ["shop-cli"])
        self.assertEqual([p["root"] for p in self.out["projects"]], ["."])


class DeterminismTest(unittest.TestCase):
    def test_serial_pool_and_warm_identical(self):
        old = ex.POOL_THRESHOLD
        try:
            a = run(copy_fixture("py-basic"), use_cache=False, workers=1)
            ex.POOL_THRESHOLD = 0
            d = copy_fixture("py-basic")
            b = run(d, use_cache=False, workers=2)
            warm = run(d, workers=2)
        finally:
            ex.POOL_THRESHOLD = old
        dump = lambda o: json.dumps({k: v for k, v in o.items() if k != "run"}, sort_keys=True)
        self.assertEqual(dump(a), dump(b))
        self.assertEqual(dump(a), dump(warm))
        self.assertEqual(warm["run"]["parsed"], [])


class IncrementalTest(unittest.TestCase):
    def test_body_edit_reparses_only_that_file(self):
        d = copy_fixture("py-basic")
        run(d)
        p = os.path.join(d, "src/shop/notify.py")
        with open(p, "a") as fh:
            fh.write("\n# comment only\n")
        self.assertEqual(run(d)["run"]["parsed"], ["src/shop/notify.py"])

    def test_shape_change_reparses_importers_transitively(self):
        d = copy_fixture("py-basic")
        run(d)
        p = os.path.join(d, "src/shop/notify.py")
        with open(p) as fh:
            src = fh.read()
        with open(p, "w") as fh:
            fh.write(src.replace("def send(", "def deliver(").replace("return send(", "return deliver("))
        out = run(d)
        # notify.py's shape changed → importers re-parse transitively; helpers.py and settings.py do not
        self.assertEqual(out["run"]["parsed"], [
            "src/shop/__init__.py", "src/shop/cli.py", "src/shop/models.py", "src/shop/notify.py",
            "src/shop/services/orders.py", "tests/test_orders.py",
        ])
        # the alias `push` now points at a missing name → no stale edge survives
        self.assertNotIn("src/shop/services/orders.py#create_order -> src/shop/notify.py#send", edges(out, "calls"))
        fresh = run(d, use_cache=False)
        dump = lambda o: json.dumps({k: v for k, v in o.items() if k != "run"}, sort_keys=True)
        self.assertEqual(dump(out), dump(fresh))


class HelpersTest(unittest.TestCase):
    def test_is_test(self):
        for p in ["tests/a.py", "pkg/test_x.py", "pkg/x_test.py", "conftest.py", "app/test/helpers.py"]:
            self.assertTrue(ex.is_test(p), p)
        for p in ["pkg/testing.py", "pkg/contest.py"]:
            self.assertFalse(ex.is_test(p), p)

    def test_absolute_module(self):
        self.assertEqual(ex.absolute_module("a.b.c", False, 1, "d"), "a.b.d")
        self.assertEqual(ex.absolute_module("a.b", True, 1, "d"), "a.b.d")
        self.assertEqual(ex.absolute_module("a.b.c", False, 2, None), "a")
        self.assertIsNone(ex.absolute_module("a", False, 3, "x"))

    def test_toml(self):
        sec = ex.read_toml_sections('[project]\nname = "x" # c\n[project.scripts]\nrun = "x.cli:main"\n')
        self.assertEqual(sec["project"], [("name", "x", 2)])
        self.assertEqual(sec["project.scripts"], [("run", "x.cli:main", 4)])


if __name__ == "__main__":
    unittest.main()


class DjangoSettingsTest(unittest.TestCase):
    def make(self, files):
        d = tempfile.mkdtemp(prefix="cg-dj-")
        for rel, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(d, rel)) or d, exist_ok=True)
            with open(os.path.join(d, rel), "w") as fh:
                fh.write(text)
        return d

    BASE = {
        "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proj.settings.dev')\n",
        "proj/__init__.py": "", "proj/settings/__init__.py": "",
        "proj/settings/base.py": "INSTALLED_APPS = ['django.contrib.auth', 'blog']\nROOT_URLCONF = 'proj.urls'\nMIDDLEWARE = []\n",
        "proj/settings/dev.py": "from .base import *\nINSTALLED_APPS += ['notes']\n",
        "proj/urls.py": "from django.urls import path\nfrom notes.views import index\nurlpatterns = [path('notes/', index)]\n",
        "blog/__init__.py": "", "notes/__init__.py": "",
        "notes/views.py": "def index(request):\n    return None\n",
    }

    def roles(self, out):
        return {n["id"]: n["meta"].get("role") for n in out["nodes"] if n["meta"].get("role")}

    def test_split_settings_via_star_import(self):
        out = run(self.make(self.BASE), use_cache=False)
        r = self.roles(out)
        self.assertEqual(r.get("py:module-group:blog"), "django-app")
        self.assertEqual(r.get("py:module-group:notes"), "django-app")  # added with += in dev.py
        eps = [n["meta"]["http"]["fullPath"] for n in out["nodes"] if n["kind"] == "endpoint"]
        self.assertEqual(eps, ["/notes/"])

    def test_non_literal_settings_warn_and_continue(self):
        files = dict(self.BASE)
        files["proj/settings/dev.py"] = "from .base import *\nINSTALLED_APPS = load_apps()\n"
        out = run(self.make(files), use_cache=False)
        self.assertIn("django-settings-dynamic", [w["code"] for w in out["warnings"]])
        self.assertEqual([n["meta"]["http"]["fullPath"] for n in out["nodes"] if n["kind"] == "endpoint"], ["/notes/"])

    def test_settings_guessed_and_config_override(self):
        files = dict(self.BASE)
        files["manage.py"] = "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', get_module())\n"
        d = self.make(files)
        out = run(d, use_cache=False)
        self.assertIn("django-settings-guessed", [w["code"] for w in out["warnings"]])
        cfg = ex.extract(d, file_list(d), [], use_cache=False, django_settings="proj.settings.dev")
        self.assertNotIn("django-settings-guessed", [w["code"] for w in cfg["warnings"]])
        self.assertEqual(self.roles(cfg).get("py:module-group:notes"), "django-app")
