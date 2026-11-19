# Keep this file Python-2-parseable so an old interpreter reports a clear error instead of a SyntaxError.
import sys

if sys.version_info < (3, 9):
    sys.stderr.write("codebase-guide sidecar needs Python >= 3.9, found %d.%d\n" % sys.version_info[:2])
    sys.exit(3)

from codebase_guide_sidecar.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
