import unittest

from parser import parse_number


class ParserTests(unittest.TestCase):
    def test_plain_number(self):
        self.assertEqual(parse_number("7"), 7)

    def test_surrounding_whitespace_is_accepted(self):
        self.assertEqual(parse_number(" 7 "), 7)


if __name__ == "__main__":
    unittest.main()
