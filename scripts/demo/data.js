'use strict';

/**
 * Demo content: realistic Dhaka venues, shops, gyms, professionals, players and events. Names are
 * invented (no real businesses or people). Money is in poisha. Photos are files in ./photos.
 *
 * Demo accounts use the phone block +8801300000001 to +8801300000199 (see README in this folder);
 * fake NID numbers use district code 99, which no real Bangladeshi NID has.
 */

// ---------------------------------------------------------------- people
// n: index in the phone block; kind: what the account is for.
const OWNERS = [
  { n: 1, name: 'Kamal Hossain', role: 'ground_owner' },
  { n: 2, name: 'Shahana Parvin', role: 'ground_owner' },
  { n: 3, name: 'Rezaul Karim', role: 'ground_owner' },
  { n: 4, name: 'Farzana Yasmin', role: 'ground_owner' },
  { n: 5, name: 'Nayeem Islam', role: 'shop_owner' },
  { n: 6, name: 'Tahmid Rahman', role: 'shop_owner' },
  { n: 7, name: 'Sadia Afrin', role: 'shop_owner' },
  { n: 8, name: 'Mahbub Alam', role: 'shop_owner' },
  { n: 9, name: 'Arifur Rahman', role: 'gym_owner' },
  { n: 10, name: 'Nusrat Jahan', role: 'gym_owner' },
  { n: 11, name: 'Tanvir Hossain', role: 'organiser' },
];

// ---------------------------------------------------------------- venues (M09)
const allWeek = (open, close) => [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, isClosed: false, openTime: open, closeTime: close }));
const VENUES = [
  {
    owner: 1,
    name: 'Kick Off Arena Mirpur',
    area: 'mirpur',
    addressLine: 'Plot 14, Road 3, Section 10, Mirpur, Dhaka',
    description: 'Floodlit 5-a-side and 7-a-side turf next to Mirpur 10 roundabout. New FIFA-grade artificial grass, changing rooms and free parking for 20 cars.',
    rulesText: 'Turf boots or trainers only. No metal studs. Arrive 10 minutes before your slot.',
    facilities: ['floodlights', 'parking', 'changing_room', 'drinking_water', 'bib_rental'],
    base: 180000,
    pricing: { peakFromHour: 17, peakPct: 25, weekendPct: 15, earlyToHour: 8, earlyPct: 0, advancePct: 25 },
    courts: [
      { name: 'Turf A (5-a-side)', sports: ['football', 'futsal'], surface: 'artificial_turf', sizeText: '40 x 20 m', capacityText: '10 players' },
      { name: 'Turf B (7-a-side)', sports: ['football'], surface: 'artificial_turf', sizeText: '55 x 30 m', capacityText: '14 players' },
    ],
    hours: allWeek('06:00', '23:00'),
    photos: ['turf-night-blue.jpg', 'turf-night-play.jpg', 'turf-lines.jpg', 'turf-ball.jpg'],
  },
  {
    owner: 1,
    name: 'Pallabi Cricket Ground',
    area: 'pallabi',
    addressLine: 'Block C, Pallabi Extension, Dhaka',
    description: 'Full-size grass ground with a turf wicket, pavilion and electronic scoreboard. Popular for weekend T20 leagues and corporate matches.',
    rulesText: 'White ball or red ball. Spikes allowed on the outfield, rubber soles on the square.',
    facilities: ['pavilion', 'scoreboard', 'sight_screens', 'parking', 'changing_room', 'drinking_water'],
    base: 450000,
    pricing: { peakFromHour: 15, peakPct: 20, weekendPct: 30, earlyToHour: 8, earlyPct: 0, advancePct: 30 },
    courts: [{ name: 'Main ground', sports: ['cricket'], surface: 'grass_turf_wicket', sizeText: '65 m boundary', capacityText: '22 players' }],
    hours: allWeek('07:00', '19:00'),
    photos: ['cricket-ground.jpg', 'cricket-batsman.jpg', 'cricket-stumps.jpg'],
  },
  {
    owner: 2,
    name: 'Dhanmondi Rooftop Turf',
    area: 'dhanmondi',
    addressLine: 'House 27, Road 8A, Dhanmondi, Dhaka',
    description: 'Rooftop futsal court with a city view, ten minutes from Dhanmondi Lake. Covered seating, showers and a small cafe downstairs.',
    rulesText: 'Futsal ball provided. Please keep the noise down after 10 pm.',
    facilities: ['floodlights', 'changing_room', 'showers', 'cafe', 'drinking_water'],
    base: 240000,
    pricing: { peakFromHour: 18, peakPct: 30, weekendPct: 20, earlyToHour: 9, earlyPct: 0, advancePct: 30 },
    courts: [{ name: 'Rooftop court', sports: ['futsal', 'football'], surface: 'artificial_turf', sizeText: '36 x 18 m', capacityText: '10 players' }],
    hours: allWeek('07:00', '23:00'),
    photos: ['turf-rooftop.jpg', 'turf-urban.jpg', 'turf-corner.jpg'],
  },
  {
    owner: 2,
    name: 'Gulshan Shuttle House',
    area: 'gulshan',
    addressLine: 'Level 3, 52 Gulshan Avenue, Gulshan 1, Dhaka',
    description: 'Four air-conditioned badminton courts with wooden floors and proper lighting. Rackets for rent and shuttles sold at the desk.',
    rulesText: 'Non-marking indoor shoes only.',
    facilities: ['air_conditioning', 'changing_room', 'racket_rental', 'lockers', 'drinking_water'],
    base: 90000,
    pricing: { peakFromHour: 17, peakPct: 20, weekendPct: 10, earlyToHour: 8, earlyPct: 0, advancePct: 50 },
    isIndoor: true,
    courts: [
      { name: 'Court 1', sports: ['badminton'], surface: 'wooden_floor' },
      { name: 'Court 2', sports: ['badminton'], surface: 'wooden_floor' },
      { name: 'Court 3', sports: ['badminton'], surface: 'wooden_floor' },
    ],
    hours: allWeek('06:00', '23:00'),
    photos: ['badminton-hall-blue.jpg', 'badminton-courts-empty.jpg', 'badminton-net.jpg'],
  },
  {
    owner: 3,
    name: 'Uttara Sports Hub',
    area: 'uttara',
    addressLine: 'Sector 11, Road 16, Uttara, Dhaka',
    description: 'A futsal turf and two indoor cricket nets with a bowling machine under one roof. Good for team practice before league games.',
    rulesText: 'Helmets are compulsory in the nets.',
    facilities: ['floodlights', 'bowling_machine', 'parking', 'changing_room', 'first_aid'],
    base: 200000,
    pricing: { peakFromHour: 17, peakPct: 25, weekendPct: 15, earlyToHour: 8, earlyPct: 0, advancePct: 25 },
    courts: [
      { name: 'Futsal turf', sports: ['futsal', 'football'], surface: 'artificial_turf', sizeText: '38 x 19 m' },
      { name: 'Cricket net 1', sports: ['cricket'], surface: 'synthetic_mat', sizeText: '22 yd lane' },
    ],
    hours: allWeek('06:00', '23:00'),
    photos: ['turf-aerial-lights.jpg', 'cricket-indoor-nets.jpg', 'turf-goal.jpg'],
  },
  {
    owner: 3,
    name: 'Bashundhara Cricket Nets',
    area: 'bashundhara',
    addressLine: 'Block D, Road 7, Bashundhara R/A, Dhaka',
    description: 'Three covered practice nets with synthetic pitches, a bowling machine and video replay. Coaching on request.',
    rulesText: 'Bring your own bat. Balls provided.',
    facilities: ['bowling_machine', 'sight_screens', 'parking', 'drinking_water'],
    base: 120000,
    pricing: { peakFromHour: 16, peakPct: 20, weekendPct: 20, earlyToHour: 8, earlyPct: 0, advancePct: 25 },
    courts: [
      { name: 'Net 1', sports: ['cricket'], surface: 'synthetic_mat', sizeText: '22 yd lane' },
      { name: 'Net 2', sports: ['cricket'], surface: 'synthetic_mat', sizeText: '22 yd lane' },
    ],
    hours: allWeek('06:00', '22:00'),
    photos: ['cricket-shot.jpg', 'cricket-stumps.jpg', 'cricket-indoor-nets.jpg'],
  },
  {
    owner: 4,
    name: 'Mohammadpur Futsal Point',
    area: 'mohammadpur',
    addressLine: 'Shyamoli Ring Road, Mohammadpur, Dhaka',
    description: 'Busy neighbourhood futsal court with bright LED floodlights. Weeknight leagues and walk-in matches.',
    rulesText: 'Maximum 12 players on court.',
    facilities: ['floodlights', 'drinking_water', 'bib_rental', 'first_aid'],
    base: 160000,
    pricing: { peakFromHour: 18, peakPct: 25, weekendPct: 15, earlyToHour: 8, earlyPct: 0, advancePct: 20 },
    courts: [{ name: 'Main court', sports: ['futsal', 'football'], surface: 'artificial_turf', sizeText: '40 x 20 m' }],
    hours: allWeek('07:00', '23:00'),
    photos: ['turf-futsal-red.jpg', 'turf-celebration.jpg', 'turf-stadium-lights.jpg'],
  },
  {
    owner: 4,
    name: 'Banani Smash Badminton',
    area: 'banani',
    addressLine: 'House 61, Road 11, Banani, Dhaka',
    description: 'Two courts on a sprung green floor, air conditioned, with coaching for juniors on weekday mornings.',
    rulesText: 'Indoor shoes only. Juniors under 12 with an adult.',
    facilities: ['air_conditioning', 'racket_rental', 'drinking_water', 'lockers'],
    base: 100000,
    pricing: { peakFromHour: 17, peakPct: 20, weekendPct: 10, earlyToHour: 8, earlyPct: 0, advancePct: 50 },
    isIndoor: true,
    courts: [
      { name: 'Court A', sports: ['badminton'], surface: 'synthetic_mat' },
      { name: 'Court B', sports: ['badminton'], surface: 'synthetic_mat' },
    ],
    hours: allWeek('06:00', '22:00'),
    photos: ['badminton-green-court.jpg', 'badminton-night.jpg', 'badminton-hall-blue.jpg'],
  },
];

// ---------------------------------------------------------------- shops and products (M12)
const SHOPS = [
  {
    owner: 5,
    shopType: 'sports_gear',
    name: 'Elephant Road Sports Corner',
    area: 'elephant_road',
    addressLine: 'Shop 18, Bata Signal Market, Elephant Road, Dhaka',
    about: 'Football and futsal gear since 2009: boots, balls, jerseys and team kits made to order.',
    products: [
      { type: 'football_boots', title: 'Turf Pro TF Football Boots', brand: 'Striker', price: 450000, specs: { stud_type: 'tf' }, axis: 'eu_size', values: ['40', '41', '42', '43', '44'], stock: 4, photos: ['gear-boots-black.jpg', 'gear-boots-grass.jpg', 'turf-lines.jpg'], description: 'Low-profile turf studs for artificial grass. Synthetic upper, padded collar.' },
      { type: 'football', title: 'Match Ball Size 5 (Hybrid Stitched)', brand: 'Striker', price: 220000, specs: { surface: 'turf' }, axis: 'size', values: ['4', '5'], stock: 10, photos: ['gear-football.jpg', 'turf-ball.jpg', 'turf-goal.jpg'], description: 'Hybrid-stitched ball that keeps its shape on turf. Butyl bladder.' },
      { type: 'jersey', title: 'Club Jersey, Red and Black Stripes', brand: 'Kitwala', price: 85000, specs: { sleeve: 'short', material: 'Polyester mesh' }, axis: 'size', values: ['S', 'M', 'L', 'XL'], stock: 12, photos: ['gear-jersey-stripe.jpg', 'gear-jersey-yellow.jpg', 'turf-celebration.jpg'], description: 'Breathable mesh jersey. Names and numbers printed for teams of 10 or more.' },
      { type: 'jersey', title: 'Goalkeeper Jersey, Long Sleeve', brand: 'Kitwala', price: 120000, specs: { sleeve: 'long', material: 'Padded polyester' }, axis: 'size', values: ['M', 'L', 'XL'], stock: 6, photos: ['gear-jersey-yellow.jpg', 'turf-night-play.jpg', 'turf-goal.jpg'], description: 'Long sleeves with light elbow padding.' },
    ],
  },
  {
    owner: 6,
    shopType: 'sports_gear',
    name: 'Mirpur Cricket Bazar',
    area: 'mirpur',
    addressLine: 'Shop 4, Stadium Market, Mirpur 2, Dhaka',
    about: 'Bats, balls and badminton gear near the national stadium. Bat knocking and grip fitting while you wait.',
    products: [
      { type: 'cricket_bat', title: 'English Willow Bat, Grade 2', brand: 'Tigers Willow', price: 1850000, specs: { willow: 'english', weight_g: 1180 }, axis: 'size', values: ['sh', 'lh'], stock: 3, photos: ['gear-cricket-bat.jpg', 'cricket-batsman.jpg', 'cricket-shot.jpg'], description: 'Seven to nine grains, pre-knocked, with a toe guard fitted.' },
      { type: 'cricket_bat', title: 'Kashmir Willow Practice Bat', brand: 'Tigers Willow', price: 450000, specs: { willow: 'kashmir', weight_g: 1150 }, axis: 'size', values: ['6', 'sh'], stock: 6, photos: ['gear-cricket-bat.jpg', 'cricket-indoor-nets.jpg', 'cricket-stumps.jpg'], description: 'Tough bat for nets and tape-ball cricket.' },
      { type: 'cricket_ball', title: 'Leather Match Ball, 4 Piece', brand: 'Bengal Sports', price: 95000, specs: { ball_type: 'leather', pieces: 4 }, axis: 'colour', values: ['red', 'white'], stock: 20, photos: ['gear-cricket-ball.jpg', 'cricket-ground.jpg', 'cricket-stumps.jpg'], description: 'Hand-stitched alum-tanned leather, 156 g.' },
      { type: 'badminton_racket', title: 'Carbon Racket 4U', brand: 'Delta Shuttle', price: 380000, specs: { balance: 'even' }, axis: 'grip', values: ['G5', 'G6'], fixed: { weight: '4U' }, stock: 5, photos: ['gear-badminton-red.jpg', 'gear-badminton-pair.jpg', 'badminton-net.jpg'], description: 'Full graphite frame, strung at 24 lbs.' },
      { type: 'shuttlecock', title: 'Feather Shuttles, Tube of 12', brand: 'Delta Shuttle', price: 145000, specs: { material: 'feather', pieces: 12 }, axis: 'speed', values: ['76', '77'], stock: 15, photos: ['gear-badminton-set.jpg', 'badminton-net.jpg', 'gear-badminton-pair.jpg'], description: 'Goose feather, cork base. Tournament grade.' },
    ],
  },
  {
    owner: 7,
    shopType: 'supplements',
    name: 'Muscle Fuel BD',
    area: 'gulshan',
    addressLine: 'Shop 7, Gulshan Pink City, Gulshan 2, Dhaka',
    about: 'Imported supplements with batch and expiry on every tub. Authorised importer, BSTI listed.',
    importer: 'Muscle Fuel Trading Ltd, Dhaka',
    products: [
      { type: 'protein_powder', title: 'Gold Whey Protein, 5 lb', brand: 'PureFuel', price: 920000, specs: { protein_type: 'whey', servings: 74 }, axis: 'flavour', values: ['chocolate', 'vanilla', 'cookies_cream'], fixed: { pack_size: '5lb' }, stock: 8, photos: ['supp-whey-can.jpg', 'supp-whey-scoop.jpg', 'supp-shaker.jpg'], description: '24 g protein per scoop, 5.5 g BCAA. Mixes in water or milk.' },
      { type: 'protein_powder', title: 'Isolate Whey, 2 lb', brand: 'PureFuel', price: 560000, specs: { protein_type: 'isolate', servings: 30 }, axis: 'flavour', values: ['chocolate', 'unflavoured'], fixed: { pack_size: '2lb' }, stock: 6, photos: ['supp-whey-jar.jpg', 'supp-whey-spill.jpg', 'supp-shaker.jpg'], description: 'Low lactose isolate, 27 g protein per scoop.' },
      { type: 'pre_workout', title: 'Pre-Workout Energy, 30 Servings', brand: 'IronCore Nutrition', price: 340000, specs: { servings: 30, caffeine_mg: 200 }, axis: 'flavour', values: ['fruit_punch', 'blue_raspberry'], stock: 7, photos: ['supp-creatine.jpg', 'supp-shaker.jpg', 'gym-machines.jpg'], description: 'Caffeine, beta-alanine and citrulline. Not for under-18s.' },
      { type: 'vitamins', title: 'Daily Multivitamin, 90 Tablets', brand: 'IronCore Nutrition', price: 150000, specs: { form: 'tablet', count: 90 }, stock: 20, photos: ['supp-creatine.jpg', 'supp-whey-jar.jpg', 'supp-shaker.jpg'], description: 'One tablet a day with food. 23 vitamins and minerals.' },
    ],
  },
  {
    owner: 8,
    shopType: 'gym_gear',
    name: 'Iron Supply Tejgaon',
    area: 'tejgaon',
    addressLine: 'Tejgaon Link Road, Plot 210, Dhaka',
    about: 'Home gym and commercial gym equipment: dumbbells, kettlebells, mats and accessories. Delivery across Dhaka.',
    products: [
      { type: 'dumbbells', title: 'Rubber Hex Dumbbells (Pair)', brand: 'IronCore', price: 220000, specs: { material: 'rubber', sold_as: 'pair' }, axis: 'weight_kg', values: ['5', '7.5', '10', '12.5'], prices: { '5': 220000, '7.5': 310000, '10': 420000, '12.5': 520000 }, stock: 6, photos: ['gymgear-dumbbell-rack.jpg', 'gymgear-dumbbell-pair.jpg', 'gym-dumbbell-rack.jpg'], description: 'Hexagonal heads so they don’t roll. Knurled chrome handles.' },
      { type: 'dumbbells', title: 'Chrome Dumbbells (Pair)', brand: 'IronCore', price: 180000, specs: { material: 'chrome', sold_as: 'pair' }, axis: 'weight_kg', values: ['2', '2.5', '5'], prices: { '2': 180000, '2.5': 210000, '5': 360000 }, stock: 8, photos: ['gymgear-chrome.jpg', 'gymgear-dumbbell-pair.jpg', 'gym-windows.jpg'], description: 'Polished chrome, ideal for home workouts.' },
      { type: 'gym_accessory', title: 'Resistance Band Set', brand: 'FlexFit', price: 95000, specs: { accessory_type: 'band' }, stock: 15, photos: ['gymgear-band.jpg', 'gymgear-wall.jpg', 'gym-class.jpg'], description: 'Five bands from 5 kg to 25 kg with handles and a door anchor.' },
      { type: 'gym_accessory', title: 'Lifting Belt, Leather', brand: 'FlexFit', price: 260000, specs: { accessory_type: 'belt' }, axis: 'size', values: ['M', 'L', 'XL'], stock: 5, photos: ['gymgear-wall.jpg', 'gymgear-kettlebells.jpg', 'gym-equipment.jpg'], description: '10 mm leather with a steel roller buckle.' },
    ],
  },
];

// ---------------------------------------------------------------- gyms (M20)
const window_ = (dows, openTime, closeTime, womenOnly = false) => dows.map((dow) => ({ dow, openTime, closeTime, womenOnly }));
const GYMS = [
  {
    owner: 9,
    name: 'Iron Yard Banani',
    area: 'banani',
    addressLine: 'House 9, Road 11, Banani, Dhaka',
    about: 'Strength gym with six squat racks, a deadlift platform and a full dumbbell range up to 50 kg. Showers and lockers.',
    facilities: ['free_weights', 'squat_racks', 'cardio_floor', 'showers', 'lockers', 'air_conditioning'],
    hours: [...window_([0, 1, 2, 3, 4, 6], '06:00', '23:00'), ...window_([5], '14:00', '22:00')],
    packages: [
      { kind: 'day', title: 'Day pass', price: 40000 },
      { kind: 'month', title: 'Monthly', price: 450000 },
      { kind: 'quarter', title: 'Quarterly', price: 1200000 },
    ],
    photos: ['gym-machines.jpg', 'gym-dumbbell-rack.jpg', 'gym-equipment.jpg'],
  },
  {
    owner: 9,
    name: 'Iron Yard Uttara',
    area: 'uttara',
    addressLine: 'Sector 7, Road 35, Uttara, Dhaka',
    about: 'Our second gym: a big cardio floor, functional zone and group classes every evening.',
    facilities: ['cardio_floor', 'functional_zone', 'free_weights', 'showers', 'air_conditioning'],
    hours: window_([0, 1, 2, 3, 4, 5, 6], '06:00', '22:00'),
    packages: [
      { kind: 'day', title: 'Day pass', price: 30000 },
      { kind: 'month', title: 'Monthly', price: 350000 },
      { kind: 'quarter', title: 'Quarterly', price: 950000 },
    ],
    photos: ['gym-bikes.jpg', 'gym-treadmills-wood.jpg', 'gym-class.jpg'],
  },
  {
    owner: 10,
    name: 'FitHer Studio Dhanmondi',
    area: 'dhanmondi',
    addressLine: 'House 45, Road 12A, Dhanmondi, Dhaka',
    about: 'A women-friendly gym with female trainers, women-only morning hours and a quiet cardio room.',
    facilities: ['cardio_floor', 'free_weights', 'lockers', 'showers', 'air_conditioning'],
    hours: [...window_([0, 1, 2, 3, 4, 6], '07:00', '12:00', true), ...window_([0, 1, 2, 3, 4, 6], '12:00', '22:00')],
    packages: [
      { kind: 'day', title: 'Day pass', price: 35000 },
      { kind: 'month', title: 'Monthly', price: 400000 },
    ],
    photos: ['gym-windows.jpg', 'gym-floor.jpg', 'gym-class.jpg'],
  },
  {
    owner: 10,
    name: 'PowerHouse Gym Mirpur',
    area: 'mirpur',
    addressLine: 'Mirpur 1, Darus Salam Road, Dhaka',
    about: 'Affordable neighbourhood gym open late, with a sauna and a functional training zone.',
    facilities: ['free_weights', 'cardio_floor', 'sauna', 'functional_zone', 'lockers'],
    hours: window_([0, 1, 2, 3, 4, 5, 6], '05:30', '23:30'),
    packages: [
      { kind: 'day', title: 'Day pass', price: 20000 },
      { kind: 'month', title: 'Monthly', price: 250000 },
      { kind: 'quarter', title: 'Quarterly', price: 680000 },
    ],
    photos: ['gym-treadmills-wood.jpg', 'gym-machines.jpg', 'gymgear-kettlebells.jpg'],
  },
];

// ---------------------------------------------------------------- hire profiles (M11) and trainers (M20)
const card = (items, extra = {}) => ({ items, nightPct: 15, shortNoticePct: 10, shortNoticeHours: 48, travel: { north: 30000, south: 50000, outside: 150000 }, maxJobsPerDay: 2, ...extra });
const PROS = [
  { n: 20, name: 'Kamrul Hasan', roleKey: 'cricket_umpire', level: 'semi_pro', credential: 'pro', area: 'dhanmondi', sports: ['cricket'], years: 6, headline: 'BCB umpire for club and league cricket', bio: 'Six seasons in the Dhaka leagues, white and red ball. Calm under pressure, on time every time.', card: card([{ unit: 'match', format: 'T20', rate: 350000 }, { unit: 'match', format: 'T10', rate: 250000 }]) },
  { n: 21, name: 'Jahid Hasan', roleKey: 'football_referee', level: 'semi_pro', credential: 'semi_pro', area: 'mirpur', sports: ['football'], years: 4, headline: 'BFF Class 3 referee for turf and league games', bio: 'Referee for corporate leagues and school tournaments across north Dhaka.', card: card([{ unit: 'match', rate: 200000 }, { unit: 'hourly', rate: 120000 }]) },
  { n: 22, name: 'Shafiqul Islam', roleKey: 'head_coach', level: 'pro', area: 'uttara', sports: ['football'], years: 12, headline: 'UEFA B licensed football coach', bio: 'Former first-division player. Coaching academy teams and adult squads.', card: card([{ unit: 'hourly', rate: 250000 }, { unit: 'match', rate: 600000 }]) },
  { n: 23, name: 'Rumana Akter', roleKey: 'physiotherapist', level: 'pro', credential: 'pro', area: 'gulshan', sports: ['cricket', 'football'], years: 8, headline: 'Sports physio, injury prevention and recovery', bio: 'Pitch-side physio for club cricket. Taping, rehab plans and match-day cover.', card: card([{ unit: 'hourly', rate: 180000 }, { unit: 'match', rate: 500000 }]) },
  { n: 24, name: 'Imran Chowdhury', roleKey: 'scorer', level: 'semi_pro', area: 'mohammadpur', sports: ['cricket'], years: 5, headline: 'Digital scorer with live scorecards', bio: 'Scoring on paper and app, with a live link for your fans.', card: card([{ unit: 'match', format: 'T20', rate: 150000 }, { unit: 'match', format: 'OD', rate: 250000 }]) },
  { n: 25, name: 'Sabbir Ahmed', roleKey: 'commentator', level: 'semi_pro', area: 'dhanmondi', sports: ['cricket', 'football'], years: 3, headline: 'Bangla and English match commentary', bio: 'Commentary for live streams and finals days.', card: card([{ unit: 'match', rate: 300000 }, { unit: 'hourly', rate: 150000 }]) },
  { n: 26, name: 'Towhid Rahman', roleKey: 'photographer', level: 'semi_pro', area: 'banani', sports: ['football', 'cricket', 'badminton'], years: 5, headline: 'Sports photographer, same-day edits', bio: 'Action shots and team photos, delivered the same evening.', card: card([{ unit: 'match', rate: 400000 }, { unit: 'hourly', rate: 200000 }]) },
  { n: 27, name: 'Nadia Sultana', roleKey: 'nutritionist', level: 'pro', credential: 'pro', area: 'gulshan', sports: ['gym', 'cricket'], years: 7, headline: 'Sports nutritionist for athletes and teams', bio: 'Meal plans for match weeks, weight goals and recovery.', card: card([{ unit: 'hourly', rate: 200000 }]) },
  { n: 28, name: 'Rakib Hossain', roleKey: 'cricket_player', platformRole: 'player', level: 'semi_pro', area: 'mirpur', sports: ['cricket'], specialisation: 'fast_bowler', years: 6, headline: 'Right-arm fast bowler for hire', bio: 'Opening bowler in the second division. Available for corporate and league matches.', card: card([{ unit: 'match', format: 'T20', rate: 250000 }, { unit: 'match', format: 'TAPE', rate: 120000 }]) },
  { n: 29, name: 'Ashik Mahmud', roleKey: 'football_player', platformRole: 'player', level: 'amateur', area: 'uttara', sports: ['football'], years: 4, headline: 'Winger, quick on turf', bio: 'Plays weekly 7-a-side and futsal leagues.', card: card([{ unit: 'match', rate: 100000 }, { unit: 'hourly', rate: 60000 }]) },
];
const TRAINERS = [
  { n: 30, name: 'Sabbir Hossain', area: 'banani', years: 7, headline: 'Strength coach, powerlifting and hypertrophy', bio: 'Certified strength coach. Programmes for beginners to competitive lifters.', rate: 150000, plan: { title: 'Strength block, 12 sessions a month', sessionsPerMonth: 12, price: 1200000, whereKind: 'gym', gym: 'Iron Yard Banani' } },
  { n: 31, name: 'Farhana Haque', area: 'dhanmondi', years: 5, headline: 'Women’s fitness and fat-loss trainer', bio: 'Female trainer for women-only sessions, at the gym or at home.', rate: 120000, plan: { title: 'Fat loss, 8 sessions a month', sessionsPerMonth: 8, price: 800000, whereKind: 'gym', gym: 'FitHer Studio Dhanmondi' } },
  { n: 32, name: 'Mehedi Hasan', area: 'mirpur', years: 4, headline: 'Functional training and conditioning', bio: 'Circuit and conditioning for footballers and cricketers.', rate: 100000, plan: { title: 'Conditioning, 10 sessions a month', sessionsPerMonth: 10, price: 700000, whereKind: 'gym', gym: 'PowerHouse Gym Mirpur' } },
  { n: 33, name: 'Tasnim Ara', area: 'uttara', years: 3, headline: 'Yoga and mobility coach', bio: 'Mobility, stretching and yoga for recovery days.', rate: 90000, plan: { title: 'Mobility online, 8 sessions a month', sessionsPerMonth: 8, price: 500000, whereKind: 'online' } },
];

// ---------------------------------------------------------------- esports players (M21)
const IGNS = ['ShadowBD', 'NightFury', 'RushKing', 'SilentSniper', 'BengalTiger', 'ZeroGravity', 'Blaze', 'Phantom', 'Viper07', 'Thunder', 'Ghost', 'Falcon', 'Raptor', 'Storm', 'Hawkeye', 'Titan', 'Nova', 'Frost', 'Venom', 'Spectre', 'Rogue', 'Ace', 'Joker', 'Cobra'];
const PLAYER_NAMES = ['Tanjim Rahman', 'Fahim Shahriar', 'Nafis Iqbal', 'Rafi Ahmed', 'Sakib Hasan', 'Mahin Chowdhury', 'Adnan Kabir', 'Tausif Alam', 'Zarif Hossain', 'Ayon Das', 'Rifat Karim', 'Shuvo Roy', 'Arnob Saha', 'Nabil Haque', 'Fardin Islam', 'Tanvir Ahmed', 'Sami Rahman', 'Junaid Khan', 'Rahat Mia', 'Imtiaz Ali', 'Mubin Hasan', 'Asif Iqbal', 'Ehsan Kabir', 'Labib Hossain'];
// The first 12 play Free Fire, the next 12 PUBG Mobile.
const PLAYERS = PLAYER_NAMES.map((name, i) => ({ n: 40 + i, name, ign: IGNS[i], username: `${IGNS[i].toLowerCase()}${10 + i}`, game: i < 12 ? 'free_fire' : 'pubg_mobile' }));

// ---------------------------------------------------------------- esports events (M21) and the showcase (M23)
// startsInDays: first match; opensInMin: registration opens (the live worker opens it on time).
const ESPORTS = [
  { key: 'ff-daily', game: 'free_fire', mode: 'solo', titleEn: 'Free Fire Daily Clash', titleBn: 'ফ্রি ফায়ার ডেইলি ক্ল্যাশ', tier: 'daily', fee: 5000, slots: 48, min: 12, prizes: [300000, 150000, 80000], killReward: 2000, startsInDays: 3, opensInMin: 1, featured: true },
  { key: 'ff-weekly', game: 'free_fire', mode: 'squad', titleEn: 'Free Fire Weekend Squad Cup', titleBn: 'ফ্রি ফায়ার উইকেন্ড স্কোয়াড কাপ', tier: 'weekly', fee: 20000, slots: 12, min: 6, prizes: [1000000, 500000, 250000], killReward: 0, startsInDays: 6, opensInMin: 1 },
  { key: 'ff-monthly', game: 'free_fire', mode: 'solo', titleEn: 'Free Fire Monthly Masters', titleBn: 'ফ্রি ফায়ার মান্থলি মাস্টার্স', tier: 'monthly', fee: 10000, slots: 48, min: 20, prizes: [2000000, 1000000, 500000], killReward: 5000, startsInDays: 18, opensInMin: 60 * 24 * 5 },
  { key: 'pm-daily', game: 'pubg_mobile', mode: 'solo', titleEn: 'PUBG Mobile Erangel Daily', titleBn: 'পাবজি মোবাইল এরাঙ্গেল ডেইলি', tier: 'daily', fee: 5000, slots: 100, min: 20, prizes: [400000, 200000, 100000], killReward: 2000, startsInDays: 2, opensInMin: 1, featured: true },
  { key: 'pm-weekly', game: 'pubg_mobile', mode: 'squad', titleEn: 'PUBG Mobile Squad Showdown', titleBn: 'পাবজি মোবাইল স্কোয়াড শোডাউন', tier: 'weekly', fee: 40000, slots: 25, min: 10, prizes: [1500000, 750000, 400000], killReward: 0, startsInDays: 8, opensInMin: 1 },
];
// The showcase: two free qualifiers feed an invite-only grand final.
const SHOWCASE = {
  titleEn: 'Kriraghor Free Fire Championship 2026',
  titleBn: 'ক্রীড়াঘর ফ্রি ফায়ার চ্যাম্পিয়নশিপ ২০২৬',
  taglineEn: 'Dhaka’s biggest Free Fire stage. Two open qualifiers, one grand final.',
  taglineBn: 'ঢাকার সবচেয়ে বড় ফ্রি ফায়ার মঞ্চ। দুটি ওপেন কোয়ালিফায়ার, একটি গ্র্যান্ড ফাইনাল।',
  aboutMd: 'Twelve qualifiers from two open rounds meet in the grand final, streamed live. Prize pool ৳1,00,000.',
  accentHex: '#f2a33a',
  banner: 'banner-stage.jpg',
  qualifiers: [
    { key: 'sc-q1', titleEn: 'FF Championship Qualifier 1', titleBn: 'এফএফ চ্যাম্পিয়নশিপ কোয়ালিফায়ার ১', startsInDays: 10, qualify: 6 },
    { key: 'sc-q2', titleEn: 'FF Championship Qualifier 2', titleBn: 'এফএফ চ্যাম্পিয়নশিপ কোয়ালিফায়ার ২', startsInDays: 11, qualify: 6 },
  ],
  final: { key: 'sc-final', titleEn: 'FF Championship Grand Final', titleBn: 'এফএফ চ্যাম্পিয়নশিপ গ্র্যান্ড ফাইনাল', startsInDays: 14, prizes: [5000000, 3000000, 2000000] },
  sponsors: [
    { name: 'Dhaka Energy Drinks', tier: 'title', url: 'https://example.com' },
    { name: 'Bengal Telecom', tier: 'partner', url: 'https://example.com' },
  ],
  poll: { questionEn: 'Who wins the grand final?', questionBn: 'গ্র্যান্ড ফাইনাল কে জিতবে?', options: [['Team ShadowBD', 'টিম শ্যাডোবিডি'], ['Team NightFury', 'টিম নাইটফিউরি'], ['Someone new', 'নতুন কেউ']] },
};
// Full profile: finished solo events (three per game, the minimum for the rolling leaderboard).
const FINISHED = [
  { game: 'free_fire', titleEn: 'Free Fire Daily Clash #1', titleBn: 'ফ্রি ফায়ার ডেইলি ক্ল্যাশ #১', tier: 'daily', daysAgo: 20 },
  { game: 'free_fire', titleEn: 'Free Fire Weekly Cup #4', titleBn: 'ফ্রি ফায়ার উইকলি কাপ #৪', tier: 'weekly', daysAgo: 13 },
  { game: 'free_fire', titleEn: 'Free Fire Daily Clash #2', titleBn: 'ফ্রি ফায়ার ডেইলি ক্ল্যাশ #২', tier: 'daily', daysAgo: 6 },
  { game: 'pubg_mobile', titleEn: 'PUBG Mobile Erangel Daily #1', titleBn: 'পাবজি মোবাইল এরাঙ্গেল ডেইলি #১', tier: 'daily', daysAgo: 19 },
  { game: 'pubg_mobile', titleEn: 'PUBG Mobile Weekly Cup #3', titleBn: 'পাবজি মোবাইল উইকলি কাপ #৩', tier: 'weekly', daysAgo: 12 },
  { game: 'pubg_mobile', titleEn: 'PUBG Mobile Erangel Daily #2', titleBn: 'পাবজি মোবাইল এরাঙ্গেল ডেইলি #২', tier: 'daily', daysAgo: 5 },
];

// ---------------------------------------------------------------- sports events (M14)
const SPORTS_ORG = { name: 'Mirpur Sports Club', about: 'Weekend leagues and knockouts in Mirpur since 2015: futsal, cricket and badminton.', area: 'mirpur' };
const SPORTS_EVENTS = [
  { key: 'futsal-league', sportKey: 'futsal', name: 'Mirpur Futsal League 2026', format: 'league', minTeams: 4, maxTeams: 8, squadMin: 5, squadMax: 10, venue: 'Kick Off Arena Mirpur', area: 'mirpur', startInDays: 9 },
  { key: 'cricket-t20', sportKey: 'cricket', name: 'Corporate T20 Knockout', format: 'knockout', minTeams: 4, maxTeams: 8, squadMin: 11, squadMax: 15, venue: 'Pallabi Cricket Ground', area: 'pallabi', startInDays: 12 },
  { key: 'badminton-open', sportKey: 'badminton', name: 'Gulshan Badminton Open', format: 'league', minTeams: 4, maxTeams: 16, squadMin: 1, squadMax: 2, venue: 'Gulshan Shuttle House', area: 'gulshan', startInDays: 8 },
];

// ---------------------------------------------------------------- the demo member (full profile)
const MEMBER = { n: 90, name: 'Ayesha Siddiqua', username: 'ayesha.s' };

// ---------------------------------------------------------------- Round B3: business staff
// Ordinary members with a verified phone (no NID, Q169), added by the owner through POST /me/team with
// the business type's default permissions. Never Kriraghor staff. `owner` is the owner's place in the
// phone block; `business` the listing's name in VENUES, GYMS or SHOPS.
const BUSINESS_STAFF = [
  { n: 194, name: 'Mithun Barua', owner: 1, businessType: 'venue', business: 'Kick Off Arena Mirpur', kind: 'Venue staff, Kick Off Arena Mirpur' },
  { n: 195, name: 'Moushumi Khatun', owner: 10, businessType: 'gym', business: 'PowerHouse Gym Mirpur', kind: 'Gym staff, PowerHouse Gym Mirpur' },
  { n: 196, name: 'Shohel Rana', owner: 8, businessType: 'shop', business: 'Iron Supply Tejgaon', kind: 'Shop staff, Iron Supply Tejgaon' },
];

// ---------------------------------------------------------------- Round B1: availability calendars (M11)
// Weekly repeats (weekdays: 0 = Sunday … 6 = Saturday, Dhaka) and one-off blocks `inDays` from today, Dhaka time.
const AVAILABILITY = [
  {
    n: 21,
    repeats: [{ weekdays: [5], from: '09:00', to: '13:00', reason: 'Jumu’ah and family' }],
    blocks: [
      { inDays: 4, from: '16:00', to: '23:00', reason: 'Cousin’s wedding in Narayanganj' },
      { inDays: 10, from: '08:00', to: '18:00', reason: 'BFF referee refresher course' },
    ],
  },
  {
    n: 30,
    repeats: [{ weekdays: [5], from: '09:00', to: '13:00', reason: 'Jumu’ah and family' }],
    blocks: [
      { inDays: 3, from: '06:00', to: '12:00', reason: 'Judging a powerlifting meet in Uttara' },
      { inDays: 9, from: '14:00', to: '20:00', reason: 'Coaching certificate exam' },
    ],
  },
];

// ---------------------------------------------------------------- Round B1: reviews (full profile)
// Past hire jobs (M11): `hirer` is a demo player (n) or the demo member (90); `review` is left out for
// the one the member has not rated yet. `reply` is the pro's answer. Jobs start at 19:00 Dhaka.
const HIRE_HISTORY = [
  { pro: 21, hirer: 41, daysAgo: 25, replyMin: 18, result: 'Mirpur Strikers 3–2 Pallabi United', review: [5, 'Jahid bhai kept the game under control from the first minute. Fair calls for both sides and he came 20 minutes early.'], reply: 'Thank you bhai, it was a clean final. Best of luck next season.' },
  { pro: 21, hirer: 44, daysAgo: 18, replyMin: 45, result: 'Office league final, 2–1', review: [4, 'Good referee for our office league final. Strict on rough tackles, which we needed. Started ten minutes late because of the traffic.'], reply: 'Thanks for the feedback. Mirpur 10 was jammed that day, I will leave earlier next time.' },
  { pro: 21, hirer: 47, daysAgo: 11, replyMin: 120, result: '7-a-side friendly, 4–4', review: [5, 'Very professional. Explained the rules to both captains before kick-off and there were no arguments after the match.'] },
  { pro: 21, hirer: 53, daysAgo: 6, replyMin: 35, result: 'Futsal semi-final, 5–3', review: [4, 'Solid referee for futsal. Friendly with the players but did not let anything slide.'] },
  { pro: 21, hirer: 90, daysAgo: 2, replyMin: 60, result: 'Family cup, 2–2' },
  { pro: 20, hirer: 42, daysAgo: 27, replyMin: 25, format: 'T20', result: 'Banani XI won by 18 runs', review: [5, 'Excellent umpiring in our corporate T20. Clear signals and he knew the playing conditions well.'], reply: 'Thank you, I enjoyed the match. Hope to see your team in the knockouts.' },
  { pro: 20, hirer: 49, daysAgo: 16, replyMin: 90, format: 'T20', result: 'Uttara Tigers won by 4 wickets', review: [4, 'Good decisions overall. One tight LBW could have gone either way, but he was very punctual.'] },
  { pro: 20, hirer: 56, daysAgo: 9, replyMin: 40, format: 'T10', result: 'Gulshan Gladiators won by 2 runs', review: [5, 'Second time we hired him. Calm, respectful and kept the over rate on track.'] },
  { pro: 23, hirer: 45, daysAgo: 13, replyMin: 30, review: [5, 'Taped two of our bowlers before the match and handled a hamstring strain quickly. Highly recommended.'] },
];
// A request the demo referee declined (so the acceptance rate is a real figure).
const HIRE_DECLINED = { pro: 21, hirer: 58, replyMin: 15, reason: 'not_available' };

// Shop orders (M13), received by the buyer `daysAgo` days ago, then rated. `reply` is the shop's answer.
const SHOP_REVIEWS = [
  { buyer: 59, shop: 'Iron Supply Tejgaon', title: 'Resistance Band Set', daysAgo: 21, review: [5, 'Good quality bands and the door anchor is solid. Delivered to Dhanmondi in two days.'], reply: 'Thank you for buying from Iron Supply. Message us when you are ready for heavier dumbbells.' },
  { buyer: 46, shop: 'Iron Supply Tejgaon', title: 'Chrome Dumbbells (Pair)', attr: '5', daysAgo: 12, review: [4, 'Nice shiny dumbbells, exactly as in the photos. Delivery took three days but the seller kept me updated.'] },
  { buyer: 50, shop: 'Iron Supply Tejgaon', title: 'Lifting Belt, Leather', attr: 'L', daysAgo: 5, review: [5, 'Thick leather and a strong buckle. Fair price compared to the shops in Gulshan.'] },
  { buyer: 48, shop: 'Mirpur Cricket Bazar', title: 'Leather Match Ball, 4 Piece', attr: 'red', daysAgo: 15, review: [5, 'Proper leather ball that keeps its shine. The shop even called to confirm the colour before sending.'] },
  { buyer: 51, shop: 'Mirpur Cricket Bazar', title: 'Feather Shuttles, Tube of 12', attr: '77', daysAgo: 7, review: [4, 'Shuttles are good for club games. Packing could be better, one tube was a bit dented.'] },
];
// The demo member rates one shop of their received order and leaves the other waiting.
const MEMBER_SHOP_REVIEW = { shop: 'Muscle Fuel BD', review: [5, 'Genuine whey with the batch number and expiry on the tub. The chocolate flavour mixes well with milk.'] };

// Gym day passes (M20) used at the front desk today, then rated. `reply` is the owner's answer.
const GYM_REVIEWS = [
  { member: 54, gym: 'PowerHouse Gym Mirpur', review: [5, 'Good equipment for the price and the sauna is a nice bonus. It gets busy after 7 pm.'], reply: 'Thank you! Come before 6 pm on weekdays if you want the squat racks free.' },
  { member: 57, gym: 'PowerHouse Gym Mirpur', review: [4, 'The day pass was easy, the front desk scanned my QR code in seconds. The AC in the cardio area could be stronger.'] },
  { member: 60, gym: 'PowerHouse Gym Mirpur', review: [4, 'Friendly trainers and open late, perfect after office. The changing room needs more lockers.'] },
];

module.exports = { OWNERS, VENUES, SHOPS, GYMS, PROS, TRAINERS, PLAYERS, ESPORTS, SHOWCASE, FINISHED, SPORTS_ORG, SPORTS_EVENTS, MEMBER, BUSINESS_STAFF, AVAILABILITY, HIRE_HISTORY, HIRE_DECLINED, SHOP_REVIEWS, MEMBER_SHOP_REVIEW, GYM_REVIEWS };
