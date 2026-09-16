import unittest

from retry import retries_for


class RetryBoundaryTests(unittest.TestCase):
    def test_negative_is_zero(self):
        self.assertEqual(retries_for(-2), 0)

    def test_zero_and_three_are_preserved(self):
        self.assertEqual(retries_for(0), 0)
        self.assertEqual(retries_for(3), 3)

    def test_above_three_is_three(self):
        self.assertEqual(retries_for(9), 3)


if __name__ == "__main__":
    unittest.main()
