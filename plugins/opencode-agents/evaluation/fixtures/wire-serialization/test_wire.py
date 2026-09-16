import unittest

from consumer import decode
from producer import encode


class WireTests(unittest.TestCase):
    def test_v2_round_trip(self):
        raw = encode("r-7", {"kind": "ping"}, version=2)
        self.assertEqual(decode(raw), ("r-7", {"kind": "ping"}))

    def test_v1_remains_compatible(self):
        raw = encode("legacy-1", {"kind": "old"}, version=1)
        self.assertEqual(decode(raw), ("legacy-1", {"kind": "old"}))


if __name__ == "__main__":
    unittest.main()
