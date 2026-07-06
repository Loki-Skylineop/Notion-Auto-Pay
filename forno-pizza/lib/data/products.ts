import type { Product, SizeOption, Topping } from "@/types";

/** Build an Unsplash delivery URL from a photo id. */
const img = (id: string) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1200&q=80`;

/** Round to 2 decimals to avoid floating point noise. */
const r = (n: number) => Math.round(n * 100) / 100;

/** The three signature pizza sizes, priced up from a base. */
function pizzaSizes(base: number): SizeOption[] {
  return [
    { id: "25", label: "25 cm", sublabel: "Personal", price: r(base) },
    { id: "30", label: "30 cm", sublabel: "Sharing", price: r(base + 4) },
    { id: "40", label: "40 cm", sublabel: "Feast", price: r(base + 8.5) },
  ];
}

/** Volume options for sodas / juices. */
function drinkSizes(base: number): SizeOption[] {
  return [
    { id: "0.33", label: "0.33 L", sublabel: "Can", price: r(base) },
    { id: "0.5", label: "0.5 L", sublabel: "Bottle", price: r(base + 1) },
    { id: "1", label: "1 L", sublabel: "Sharing", price: r(base + 2.6) },
  ];
}

/** Shared add-on toppings offered on every pizza. */
export const PIZZA_TOPPINGS: Topping[] = [
  { id: "mozzarella", name: "Extra mozzarella", price: 1.5 },
  { id: "pepperoni", name: "Spicy pepperoni", price: 2 },
  { id: "mushrooms", name: "Wild mushrooms", price: 1.5 },
  { id: "olives", name: "Kalamata olives", price: 1 },
  { id: "basil", name: "Fresh basil", price: 0.75 },
  { id: "chili", name: "Chili flakes", price: 0.5 },
  { id: "prosciutto", name: "Prosciutto di Parma", price: 2.75 },
  { id: "truffle", name: "Truffle oil drizzle", price: 3 },
];

// ---------------------------------------------------------------------------
// Pizzas (12)
// ---------------------------------------------------------------------------

const pizzas: Product[] = [
  {
    id: "margherita",
    name: "Margherita",
    description: "The timeless classic — San Marzano tomato, fior di latte & basil.",
    longDescription:
      "Our signature Margherita is a tribute to Naples: a 48-hour fermented sourdough base, hand-crushed San Marzano tomatoes, creamy fior di latte and just-picked basil, finished with a thread of Sicilian olive oil.",
    image: img("1574071318508-1cdbab80d002"),
    category: "pizza",
    sizes: pizzaSizes(11.9),
    tags: ["Bestseller", "Vegetarian", "Classic"],
    ingredients: ["San Marzano tomato", "Fior di latte", "Fresh basil", "Olive oil", "Sea salt"],
    toppings: PIZZA_TOPPINGS,
    popularity: 98,
    kcal: 850,
    spiceLevel: 0,
  },
  {
    id: "pepperoni",
    name: "Pepperoni Classica",
    description: "Double-cupped pepperoni that crisps at the edges, chili honey drizzle.",
    longDescription:
      "A crowd favourite: layers of double-cupped pepperoni that curl and char in the wood oven, molten mozzarella and a finishing drizzle of chili honey for a sweet-heat kick.",
    image: img("1628840042765-356cda07504e"),
    category: "pizza",
    sizes: pizzaSizes(13.5),
    tags: ["Bestseller", "Spicy"],
    ingredients: ["Tomato sauce", "Mozzarella", "Double pepperoni", "Chili honey", "Oregano"],
    toppings: PIZZA_TOPPINGS,
    popularity: 96,
    kcal: 1020,
    spiceLevel: 1,
  },
  {
    id: "quattro-formaggi",
    name: "Quattro Formaggi",
    description: "Mozzarella, gorgonzola, fontina & aged parmesan on a white base.",
    longDescription:
      "Four cheeses in perfect harmony over a garlic-cream white base: stretchy mozzarella, punchy gorgonzola, nutty fontina and a snowfall of aged parmesan.",
    image: img("1595854341625-f33ee10dbf94"),
    category: "pizza",
    sizes: pizzaSizes(14.5),
    tags: ["Vegetarian", "Premium"],
    ingredients: ["Mozzarella", "Gorgonzola", "Fontina", "Parmesan", "Garlic cream"],
    toppings: PIZZA_TOPPINGS,
    popularity: 82,
    kcal: 1120,
    spiceLevel: 0,
  },
  {
    id: "diavola",
    name: "Diavola",
    description: "Spicy salami, 'nduja, roasted peppers & a fiery chili oil.",
    longDescription:
      "For the heat seekers: fiery Calabrian 'nduja, spicy salami, roasted red peppers and a brush of house chili oil. Bold, smoky and unapologetically hot.",
    image: img("1601925261345-4b3ba3fda8df"),
    category: "pizza",
    sizes: pizzaSizes(14.9),
    tags: ["Spicy", "New"],
    ingredients: ["Tomato sauce", "Mozzarella", "Spicy salami", "'Nduja", "Roasted peppers", "Chili oil"],
    toppings: PIZZA_TOPPINGS,
    popularity: 88,
    kcal: 1080,
    spiceLevel: 3,
  },
  {
    id: "ortolana",
    name: "Ortolana",
    description: "Grilled zucchini, aubergine, peppers & cherry tomatoes.",
    longDescription:
      "A garden on a crust: chargrilled zucchini and aubergine, sweet peppers, roasted cherry tomatoes and fresh rocket over stretchy mozzarella.",
    image: img("1565299624946-b28f40a0ae38"),
    category: "pizza",
    sizes: pizzaSizes(13.5),
    tags: ["Vegetarian", "Vegan"],
    ingredients: ["Tomato sauce", "Mozzarella", "Zucchini", "Aubergine", "Peppers", "Cherry tomato", "Rocket"],
    toppings: PIZZA_TOPPINGS,
    popularity: 74,
    kcal: 760,
    spiceLevel: 0,
  },
  {
    id: "bolognese",
    name: "Carnivora",
    description: "Slow-cooked beef ragù, smoked pancetta & caramelised onion.",
    longDescription:
      "A meat-lover's dream: rich slow-cooked beef ragù, smoked pancetta, spicy sausage and caramelised onion, layered over tomato and mozzarella.",
    image: img("1594007654729-407eedc4be65"),
    category: "pizza",
    sizes: pizzaSizes(15.5),
    tags: ["Premium", "Bestseller"],
    ingredients: ["Tomato sauce", "Mozzarella", "Beef ragù", "Pancetta", "Italian sausage", "Onion"],
    toppings: PIZZA_TOPPINGS,
    popularity: 90,
    kcal: 1180,
    spiceLevel: 1,
  },
  {
    id: "salame-piccante",
    name: "Salame Piccante",
    description: "Spicy Calabrian salami, red onion & a scatter of chili.",
    longDescription:
      "Thin slices of spicy Calabrian salami, sweet red onion and a scatter of chili flakes over a classic tomato and mozzarella base.",
    image: img("1552539618-7eec9b4d1796"),
    category: "pizza",
    sizes: pizzaSizes(13.9),
    tags: ["Spicy"],
    ingredients: ["Tomato sauce", "Mozzarella", "Calabrian salami", "Red onion", "Chili flakes"],
    toppings: PIZZA_TOPPINGS,
    popularity: 79,
    kcal: 980,
    spiceLevel: 2,
  },
  {
    id: "bianca-tartufo",
    name: "Bianca al Tartufo",
    description: "Truffle cream, wild mushrooms, mozzarella & thyme.",
    longDescription:
      "An elegant white pizza: earthy truffle cream, a medley of wild mushrooms, mozzarella and fresh thyme, finished with a drizzle of truffle oil.",
    image: img("1593560708920-61dd98c46a4e"),
    category: "pizza",
    sizes: pizzaSizes(16.5),
    tags: ["Premium", "Vegetarian", "New"],
    ingredients: ["Truffle cream", "Mozzarella", "Wild mushrooms", "Thyme", "Truffle oil"],
    toppings: PIZZA_TOPPINGS,
    popularity: 71,
    kcal: 940,
    spiceLevel: 0,
  },
  {
    id: "napoletana",
    name: "Napoletana",
    description: "Anchovies, capers, olives & oregano — salty, briny, honest.",
    longDescription:
      "A Neapolitan staple bursting with the flavours of the coast: anchovies, salty capers, black olives and oregano over San Marzano tomato.",
    image: img("1513104890138-7c749659a591"),
    category: "pizza",
    sizes: pizzaSizes(13.9),
    tags: ["Classic", "Bestseller"],
    ingredients: ["San Marzano tomato", "Mozzarella", "Anchovies", "Capers", "Black olives", "Oregano"],
    toppings: PIZZA_TOPPINGS,
    popularity: 84,
    kcal: 890,
    spiceLevel: 0,
  },
  {
    id: "regina",
    name: "Regina",
    description: "Cooked ham, mushrooms & mozzarella — a family classic.",
    longDescription:
      "The 'Queen' — a beloved family classic of cooked ham, sautéed mushrooms and mozzarella over a rich tomato base. Comforting and always a hit.",
    image: img("1585238342028-4bd06167b784"),
    category: "pizza",
    sizes: pizzaSizes(13.5),
    tags: ["Classic"],
    ingredients: ["Tomato sauce", "Mozzarella", "Cooked ham", "Mushrooms"],
    toppings: PIZZA_TOPPINGS,
    popularity: 77,
    kcal: 960,
    spiceLevel: 0,
  },
  {
    id: "prosciutto-rucola",
    name: "Prosciutto e Rucola",
    description: "Prosciutto di Parma, rocket, cherry tomato & parmesan shavings.",
    longDescription:
      "Finished after baking with delicate Prosciutto di Parma, peppery rocket, sweet cherry tomatoes and shavings of parmesan for a fresh, fragrant bite.",
    image: img("1537734796389-e1fc293cf856"),
    category: "pizza",
    sizes: pizzaSizes(16.9),
    tags: ["Premium", "New"],
    ingredients: ["Tomato sauce", "Mozzarella", "Prosciutto di Parma", "Rocket", "Cherry tomato", "Parmesan"],
    toppings: PIZZA_TOPPINGS,
    popularity: 86,
    kcal: 900,
    spiceLevel: 0,
  },
  {
    id: "doppio-formaggio",
    name: "Doppio Formaggio",
    description: "A double hit of mozzarella with a golden, bubbling crust.",
    longDescription:
      "Simple perfection for cheese devotees: a double layer of fior di latte and mozzarella that bubbles and blisters, over a lightly seasoned tomato base.",
    image: img("1574126154517-d1e0d89ef734"),
    category: "pizza",
    sizes: pizzaSizes(12.9),
    tags: ["Vegetarian", "New"],
    ingredients: ["Tomato sauce", "Fior di latte", "Mozzarella", "Oregano"],
    toppings: PIZZA_TOPPINGS,
    popularity: 80,
    kcal: 1010,
    spiceLevel: 0,
  },
];

// ---------------------------------------------------------------------------
// Drinks (6)
// ---------------------------------------------------------------------------

const drinks: Product[] = [
  {
    id: "cola",
    name: "Classic Cola",
    description: "Ice-cold cola with a crisp, caramel fizz.",
    image: img("1554866585-cd94860890b7"),
    category: "drinks",
    sizes: drinkSizes(2.5),
    tags: ["Cold", "Bestseller"],
    ingredients: ["Carbonated water", "Cola", "Natural flavours"],
    popularity: 92,
    kcal: 139,
  },
  {
    id: "lemonade",
    name: "Sicilian Lemonade",
    description: "Freshly pressed lemons, lightly sparkling and tart.",
    image: img("1621263764928-df1444c5e859"),
    category: "drinks",
    sizes: drinkSizes(3.2),
    tags: ["Cold", "New"],
    ingredients: ["Sicilian lemon", "Sparkling water", "Cane sugar", "Mint"],
    popularity: 81,
    kcal: 120,
  },
  {
    id: "orange-juice",
    name: "Fresh Orange Juice",
    description: "100% freshly squeezed oranges — nothing added.",
    image: img("1600271886742-f049cd451bba"),
    category: "drinks",
    sizes: drinkSizes(3.6),
    tags: ["Cold"],
    ingredients: ["Freshly squeezed oranges"],
    popularity: 76,
    kcal: 110,
  },
  {
    id: "iced-tea",
    name: "Peach Iced Tea",
    description: "House-brewed black tea with ripe peach and lemon.",
    image: img("1556679343-c7306c1976bc"),
    category: "drinks",
    sizes: drinkSizes(2.9),
    tags: ["Cold"],
    ingredients: ["Black tea", "Peach", "Lemon", "Cane sugar"],
    popularity: 70,
    kcal: 95,
  },
  {
    id: "sparkling-water",
    name: "Sparkling Water",
    description: "Naturally sparkling mineral water, crisp and clean.",
    image: img("1523362628745-0c100150b504"),
    category: "drinks",
    sizes: [
      { id: "0.5", label: "0.5 L", sublabel: "Bottle", price: 1.9 },
      { id: "1", label: "1 L", sublabel: "Sharing", price: 2.9 },
    ],
    tags: ["Cold", "Vegan"],
    ingredients: ["Natural mineral water", "Carbonation"],
    popularity: 64,
    kcal: 0,
  },
  {
    id: "choc-milkshake",
    name: "Chocolate Milkshake",
    description: "Thick, creamy chocolate shake topped with whipped cream.",
    image: img("1530373239216-42518e6b4063"),
    category: "drinks",
    sizes: [{ id: "0.4", label: "0.4 L", sublabel: "Regular", price: 5.5 }],
    tags: ["Cold", "Sweet"],
    ingredients: ["Milk", "Chocolate", "Vanilla ice cream", "Whipped cream"],
    popularity: 85,
    kcal: 430,
  },
];

// ---------------------------------------------------------------------------
// Desserts (5)
// ---------------------------------------------------------------------------

const desserts: Product[] = [
  {
    id: "tiramisu",
    name: "Tiramisù",
    description: "Espresso-soaked ladyfingers, mascarpone cream & cocoa.",
    longDescription:
      "The definitive Italian dessert: layers of espresso-soaked savoiardi, silky mascarpone cream and a generous dusting of bitter cocoa. Made fresh daily.",
    image: img("1571877227200-a0d98ea607e9"),
    category: "desserts",
    sizes: [{ id: "regular", label: "Portion", price: 6.5 }],
    tags: ["Sweet", "Bestseller", "Classic"],
    ingredients: ["Mascarpone", "Savoiardi", "Espresso", "Cocoa", "Egg", "Sugar"],
    popularity: 94,
    kcal: 420,
  },
  {
    id: "lava-cake",
    name: "Chocolate Lava Cake",
    description: "Warm dark-chocolate cake with a molten, gooey centre.",
    longDescription:
      "A warm dark-chocolate sponge with a molten centre that flows the moment your spoon breaks the surface, served with a scoop of vanilla gelato.",
    image: img("1624353365286-3f8d62daad51"),
    category: "desserts",
    sizes: [{ id: "regular", label: "Portion", price: 7 }],
    tags: ["Sweet", "New"],
    ingredients: ["Dark chocolate", "Butter", "Egg", "Flour", "Vanilla gelato"],
    popularity: 89,
    kcal: 510,
  },
  {
    id: "cheesecake",
    name: "New York Cheesecake",
    description: "Dense, creamy cheesecake on a buttery biscuit base.",
    longDescription:
      "A slice of pure indulgence: dense, creamy baked cheesecake on a buttery graham base, crowned with a bright berry compote.",
    image: img("1533134242443-d4fd215305ad"),
    category: "desserts",
    sizes: [{ id: "regular", label: "Slice", price: 6.9 }],
    tags: ["Sweet", "Bestseller"],
    ingredients: ["Cream cheese", "Biscuit base", "Vanilla", "Berry compote"],
    popularity: 83,
    kcal: 460,
  },
  {
    id: "creme-brulee",
    name: "Crème Brûlée",
    description: "Silky vanilla custard under a crackly caramel top.",
    longDescription:
      "Classic vanilla-bean custard set beneath a torched sugar crust that shatters at the tap of a spoon. Finished with fresh berries.",
    image: img("1470124182917-cc6e71b22ecc"),
    category: "desserts",
    sizes: [{ id: "regular", label: "Portion", price: 7.5 }],
    tags: ["Sweet", "Premium"],
    ingredients: ["Cream", "Vanilla bean", "Egg yolk", "Caramelised sugar", "Berries"],
    popularity: 72,
    kcal: 390,
  },
  {
    id: "nutella-waffle",
    name: "Nutella Waffle",
    description: "Warm Belgian waffle, molten Nutella & toasted hazelnuts.",
    longDescription:
      "A crisp-edged Belgian waffle drenched in warm Nutella, scattered with toasted hazelnuts and a dusting of icing sugar. Pure comfort.",
    image: img("1562376552-0d160a2f238d"),
    category: "desserts",
    sizes: [{ id: "regular", label: "Portion", price: 6.9 }],
    tags: ["Sweet", "New"],
    ingredients: ["Belgian waffle", "Nutella", "Hazelnuts", "Icing sugar"],
    popularity: 78,
    kcal: 540,
  },
];

// ---------------------------------------------------------------------------

export const products: Product[] = [...pizzas, ...drinks, ...desserts];

export const productById = new Map(products.map((p) => [p.id, p]));

export function getProduct(id: string): Product | undefined {
  return productById.get(id);
}

/** Featured pizza used in the homepage hero. */
export const featuredProduct = pizzas[0];
