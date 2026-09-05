"""Git diagnostics must never become patch content (notably Windows CRLF warnings)."""
import contextlib
import io
import subprocess
import unittest
from unittest.mock import patch

import export_web_patch


class ExportWebPatchTest(unittest.TestCase):
    def test_warning_does_not_contaminate_diff(self):
        diff = "diff --git a/example b/example\n"
        result = subprocess.CompletedProcess([], 0, diff, "warning: LF will be replaced by CRLF\n")
        with patch.object(export_web_patch.subprocess, "run", return_value=result) as run:
            self.assertEqual(export_web_patch.git("diff"), diff)
            self.assertEqual(run.call_args.kwargs["stderr"], subprocess.PIPE)

    def test_failure_includes_diagnostic(self):
        result = subprocess.CompletedProcess([], 1, "", "fatal: unavailable baseline")
        message = io.StringIO()
        with patch.object(export_web_patch.subprocess, "run", return_value=result):
            with contextlib.redirect_stderr(message), self.assertRaises(SystemExit):
                export_web_patch.git("diff")
        self.assertIn("unavailable baseline", message.getvalue())


if __name__ == "__main__":
    unittest.main()
