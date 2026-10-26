import unittest

from scripts.sync_godderob_stock import parse_stock


class ParseStockTests(unittest.TestCase):
    def test_exports_positive_sizes_and_capped_order_quantities(self):
        csv_text = """Артикул_размера,Модель,Цвет,Категория,Размер,Общий остаток,Статус,Минск,,Гомель
Jesus lovers беж_S,Jesus lovers club,Бежевый,Полузип,S,0,нет,0,,
Jesus lovers беж _M,,,,M,0,нет,0,,
Jesus lovers беж_L,,,,L,3,мало,3,,
NAME графит_S,NAME,Графит,Футболка,S,2,мало,2,,
NAME графит_XL,,,,XL,0,нет,0,,
By Jesus_лонг_2XL,By Jesus,Синий,Лонг,2XL,2,мало,2,,
Барашек_изумруд_М,JESUS is my Shepherd,изумруд,свитшот,M,5,много,5,,
Praise синий_лонг S,Praise the Lord,Синий,Лонгслив,S,1,мало,1,,
Бог есть любовь_роз_XS,Бог есть любовь,Розовый,Футболка,XS,0,нет,0,,
Child of God борд_M,Child of God,С бордовым,Свитшот,M,10,много,10,,
"""

        stock = parse_stock(csv_text)

        self.assertEqual(stock["availableSizes"]["jesus-lovers-club-men"]["бежевый"], ["L"])
        self.assertEqual(stock["availableSizes"]["name"]["графитовый"], ["S"])
        self.assertEqual(stock["availableSizes"]["by-jesus"]["тёмно-синий"], ["2XL"])
        self.assertEqual(stock["availableSizes"]["shepherd-men"]["изумруд"], ["M"])
        self.assertEqual(stock["availableSizes"]["praise-long-men"]["синий"], ["S"])
        self.assertEqual(stock["maxOrderable"]["jesus-lovers-club-men"]["бежевый"]["L"], 3)
        self.assertEqual(stock["maxOrderable"]["name"]["графитовый"]["S"], 2)
        self.assertEqual(stock["maxOrderable"]["child-of-god"]["розовый"]["M"], 3)
        self.assertNotIn("bog-est-lubov-women", stock["availableSizes"])
        self.assertIn("bog-est-lubov-women|розовый", stock["managedVariants"])
        self.assertNotIn("Общий остаток", str(stock))
        self.assertNotIn("10", repr(stock))
        self.assertEqual(stock["schemaVersion"], 2)

    def test_rejects_empty_or_unrecognized_sheet(self):
        with self.assertRaises(ValueError):
            parse_stock("Артикул_размера,Размер,Общий остаток\n")


if __name__ == "__main__":
    unittest.main()
