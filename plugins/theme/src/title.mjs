const products=['DSH 本地构建','DSH Local Build','DeepSeek Harness','DSHローカルビルド','Version locale de DSH','Локальная сборка DSH','Compilación local de DSH','Lokaler DSH-Build','Versão local do DSH'];
export function brandedTitle(title){
  for(const product of products){
    if(title===product)return '拾文 · Shiwen';
    const suffix=` — ${product}`;
    if(title.endsWith(suffix))return title.slice(0,-suffix.length)+' — 拾文 · Shiwen';
  }
  return title;
}
