"""The shipped code-only server baselines must match their reviewed manifest."""
import hashlib
import json
from pathlib import Path
import unittest


class FixtureIntegrityTest(unittest.TestCase):
    def test_exact_reviewed_fixture_bytes(self):
        root = Path(__file__).parent / 'fixtures/r366'
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(set(manifest['files']), {
            'community_workshop.py', 'card_version_workshop.py', 'provider_runtime_baseline.py'})
        for name, expected in manifest['files'].items():
            with self.subTest(file=name):
                data = (root / name).read_bytes()
                self.assertEqual(len(data), expected['bytes'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), expected['sha256'])


if __name__ == '__main__':
    unittest.main()
