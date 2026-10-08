// GIF（Klipy）・ランダムカタカナ
import { KLIPY_API_KEY } from '../config.js';

async function klipyFetch(endpoint) {
  // /api/v1/{key}/ 形式と /api/v1/k/{key}/ 形式を両方試す
  const url = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}${endpoint}`;
  console.log(`🎬 Klipy request: ${url.replace(KLIPY_API_KEY, '[KEY]')}`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Klipy API error: ${res.status} (${body.slice(0, 200)})`);
  }
  return res.json();
}

function extractGifUrl(item) {
  if (!item) return null;
  // Klipy形式: item.file.hd.gif.url
  if (item.file) {
    return item.file.hd?.gif?.url ?? item.file.hd?.webp?.url
        ?? item.file.sd?.gif?.url ?? item.file.sd?.webp?.url ?? null;
  }
  if (typeof item.url === 'string' && item.url.includes('http')) return item.url;
  if (item.media && !Array.isArray(item.media)) {
    return item.media.gif?.url ?? item.media.tinygif?.url ?? item.media.mediumgif?.url ?? null;
  }
  if (Array.isArray(item.media) && item.media[0]) {
    const m = item.media[0];
    return m.gif?.url ?? m.tinygif?.url ?? m.mediumgif?.url ?? null;
  }
  return item.gif_url ?? item.images?.original?.url ?? null;
}

// Klipy APIレスポンスからアイテム配列を取得
function extractKlipyItems(data) {
  // Klipy形式: { result: true, data: { data: [...] } }
  const inner = data?.data;
  if (Array.isArray(inner?.data)) return inner.data;
  if (Array.isArray(inner)) return inner;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

export async function getRandomGif() {
  const randomWords = ['funny', 'happy', 'cool', 'wow', 'yes', 'ok', 'love', 'party', 'amazing', 'cute'];
  const word  = randomWords[Math.floor(Math.random() * randomWords.length)];
  const data  = await klipyFetch(`/gifs/search?q=${encodeURIComponent(word)}&limit=50`);
  const items = extractKlipyItems(data);
  if (items.length === 0) throw new Error('GIFが取得できませんでした');
  const item  = items[Math.floor(Math.random() * items.length)];
  const url   = extractGifUrl(item);
  if (!url) throw new Error('GIFのURLが取得できませんでした');
  return url;
}

export async function getKlipyCategories() {
  try {
    const data = await klipyFetch('/gifs/categories');
    // レスポンス形式を柔軟に処理（Klipy は { result, data: { categories: [...] } } のように入れ子になっている）
    const candidates = [
      data?.data, data?.data?.categories, data?.data?.data, data?.data?.tags,
      data?.categories, data?.tags, data?.results,
    ];
    const list = candidates.find(c => Array.isArray(c) && c.length > 0) ?? [];
    if (list.length === 0) console.log('🎬 Klipyカテゴリ形式不明:', JSON.stringify(data).slice(0, 300));
    // { category, query } 形式にも対応
    return list.map(c => (typeof c === 'string' ? c : { name: c.name ?? c.category ?? c.title ?? c.query, slug: c.query ?? c.slug ?? c.searchterm ?? c.name ?? c.category }));
  } catch (e) {
    console.error('カテゴリ取得失敗:', e.message);
    return [];
  }
}

export async function getRandomGifByCategory(categoryName) {
  const data  = await klipyFetch(`/gifs/search?q=${encodeURIComponent(categoryName)}&limit=50`);
  const items = extractKlipyItems(data);
  if (items.length === 0) throw new Error('GIFが取得できませんでした');
  const item  = items[Math.floor(Math.random() * items.length)];
  const url   = extractGifUrl(item);
  if (!url) throw new Error('GIFのURLが取得できませんでした');
  return url;
}

export function generateRandomKatakana(length) {
  const chars = [
    'ア','イ','ウ','エ','オ','カ','キ','ク','ケ','コ',
    'サ','シ','ス','セ','ソ','タ','チ','ツ','テ','ト',
    'ナ','ニ','ヌ','ネ','ノ','ハ','ヒ','フ','ヘ','ホ',
    'マ','ミ','ム','メ','モ','ヤ','ユ','ヨ',
    'ラ','リ','ル','レ','ロ','ワ','ヲ','ン','ッ','ー',
    'ガ','ギ','グ','ゲ','ゴ','ザ','ジ','ズ','ゼ','ゾ',
    'ダ','ヂ','ヅ','デ','ド','バ','ビ','ブ','ベ','ボ',
    'パ','ピ','プ','ペ','ポ',
    'キャ','キュ','キョ','シャ','シュ','ショ','シェ',
    'チャ','チュ','チョ','チェ','ニャ','ニュ','ニョ',
    'ヒャ','ヒュ','ヒョ','ミャ','ミュ','ミョ',
    'リャ','リュ','リョ','ギャ','ギュ','ギョ',
    'ジャ','ジュ','ジョ','ジェ','ビャ','ビュ','ビョ',
    'ピャ','ピュ','ピョ','ファ','フィ','フェ','フォ',
    'ヴァ','ヴィ','ヴ','ヴェ','ヴォ','ウィ','ウェ','ウォ',
  ];
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
