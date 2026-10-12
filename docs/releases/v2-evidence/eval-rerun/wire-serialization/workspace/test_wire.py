import json
import unittest

from consumer import decode
from producer import encode


class WireTests(unittest.TestCase):
    def test_v2_envelope_round_trip(self):
        raw = encode("r-7", {"kind": "ping"})
        self.assertEqual(json.loads(raw), {
            "version": 2,
            "request": {"id": "r-7", "body": {"kind": "ping"}},
        })
        self.assertEqual(decode(raw), ("r-7", {"kind": "ping"}))

    def test_missing_version_is_rejected(self):
        raw = json.dumps({"request": {"id": "r-7", "body": {"kind": "ping"}}})
        with self.assertRaises(ValueError):
            decode(raw)


if __name__ == "__main__":
    unittest.main()
