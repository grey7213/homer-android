"""Git diagnostics must never become patch content (notably Windows CRLF warnings)."""
import contextlib
import io
import subprocess
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

import export_web_patch


class ExportWebPatchTest(unittest.TestCase):
    def test_warning_does_not_contaminate_diff(self):
        diff = "diff --git a/example b/example\n"
        result = subprocess.CompletedProcess([], 0, diff.encode(), b"warning: LF will be replaced by CRLF\n")
        with patch.object(export_web_patch.subprocess, "run", return_value=result) as run:
            self.assertEqual(export_web_patch.git("diff"), diff)
            self.assertEqual(run.call_args.kwargs["stderr"], subprocess.PIPE)

    def test_failure_includes_diagnostic(self):
        result = subprocess.CompletedProcess([], 1, b"", b"fatal: unavailable baseline")
        message = io.StringIO()
        with patch.object(export_web_patch.subprocess, "run", return_value=result):
            with contextlib.redirect_stderr(message), self.assertRaises(SystemExit):
                export_web_patch.git("diff")
        self.assertIn("unavailable baseline", message.getvalue())

    def test_diff_preserves_authored_crlf_bytes(self):
        diff = b"diff --git a/example b/example\n@@ -1 +1 @@\n-old\r\n+new\r\n"
        result = subprocess.CompletedProcess([], 0, diff, b"")
        with patch.object(export_web_patch.subprocess, "run", return_value=result):
            self.assertEqual(export_web_patch.git("diff", preserve_newlines=True).encode(), diff)
            self.assertNotIn('\r', export_web_patch.git("status"))

    def test_repository_index_preserves_exported_patch_bytes(self):
        attributes = (export_web_patch.ROOT / '.gitattributes').read_bytes()
        with tempfile.TemporaryDirectory(prefix='homer-patch-index-') as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '--quiet', directory], check=True)
            subprocess.run(['git', '-C', directory, 'config', 'core.autocrlf', 'true'], check=True)
            (root / '.gitattributes').write_bytes(attributes)
            (root / 'web-patches').mkdir()
            payload = b'diff --git a/file b/file\n@@ -1 +1 @@\n-old\r\n+new\r\n'
            (root / 'web-patches/test.patch').write_bytes(payload)
            subprocess.run(['git', '-C', directory, 'add', '--', '.gitattributes', 'web-patches/test.patch'], check=True)
            actual = subprocess.check_output(['git', '-C', directory, 'show', ':web-patches/test.patch'])
            self.assertEqual(actual, payload)


if __name__ == "__main__":
    unittest.main()
