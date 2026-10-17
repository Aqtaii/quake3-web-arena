import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const originalMaps = ['q3dm1', 'q3dm7', 'q3dm17', 'q3tourney2'];
export function readGameData(root) {
    const manifest = JSON.parse(readFileSync(join(root, 'game-data.json'), 'utf8'));
    const maps = manifest.maps ?? originalMaps;
    const packages = manifest.packages;
    const serverPackages = manifest.serverPackages ?? packages;
    if (!Array.isArray(maps) || !maps.length ||
        maps.some(map => typeof map !== 'string' || !/^[a-z0-9_]{1,48}$/.test(map)) ||
        new Set(maps).size !== maps.length) throw Error('Invalid installed map list');
    for (const list of [packages, serverPackages]) {
        if (!Array.isArray(list) || !list.length ||
            list.some(name => typeof name !== 'string' || !/^pak[0-9]+\.pk3$/.test(name) ||
                !existsSync(join(root, 'baseq3', name))) ||
            new Set(list).size !== list.length) throw Error('Invalid or missing game package');
    }
    if (serverPackages.some(name => !packages.includes(name))) throw Error('Server package is absent from client manifest');
    return { ...manifest, maps, packages, serverPackages };
}
