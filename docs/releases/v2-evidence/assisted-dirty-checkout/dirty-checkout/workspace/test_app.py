import unittest

from app import greeting


class AppTests(unittest.TestCase):
    def test_greeting_has_requested_punctuation(self):
        self.assertEqual(greeting("Ada"), "Hello, Ada!")


if __name__ == "__main__":
    unittest.main()
