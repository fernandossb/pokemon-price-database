import fs from 'node:fs/promises';
import { loadTcgplayerProductPrices } from './providers/tcgcsv.mjs';

// Preços do TCGplayer por produto (tcgcsv.com), usados para as versões
// especiais das cartas (Cosmos Holo, Poké Ball...) — ver lib.mjs. Se o
// tcgcsv falhar, o banco segue sem esses preços: nada mais depende deles.
await fs.mkdir('work', { recursive: true });
let result;
try {
  result = await loadTcgplayerProductPrices();
  console.log(`TCGplayer por produto: ${Object.keys(result.products).length} produtos, ${result.priced} preços, ${result.failedGroups}/${result.groups} grupos com falha.`);
} catch (error) {
  console.warn(`tcgcsv indisponível; versões especiais ficam só com o que o TCGdex trouxer: ${error.message}`);
  result = { generatedAt: new Date().toISOString(), groups: 0, failedGroups: 0, priced: 0, products: {}, error: error.message };
}
await fs.writeFile('work/tcgplayer-products.json', JSON.stringify(result));
