import sys

if sys.platform == "win32":
    class Lock:
        def acquire(self):
            return self._raw()

        def _raw(self):
            return 1
else:
    class Lock:
        def acquire(self):
            return self._raw()

        def _raw(self):
            return 2
