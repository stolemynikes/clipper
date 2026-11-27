import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGame } from './game.ts';

test('findGame spots games in launcher folders, not the launchers', () => {
  const base = ['explorer|C:\\Windows\\explorer.exe', 'steam|C:\\Program Files (x86)\\Steam\\steam.exe',
    'EpicGamesLauncher|C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
    'RiotClientServices|C:\\Riot Games\\Riot Client\\RiotClientServices.exe'];
  assert.equal(findGame(base), null);
  assert.equal(findGame([...base, 'cs2|D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe']), 'cs2');
  assert.equal(findGame([...base, 'VALORANT-Win64-Shipping|C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe']), 'VALORANT-Win64-Shipping');
  assert.equal(findGame([...base, 'Minecraft|C:\\Games\\Minecraft.exe'], ['minecraft.exe']), 'Minecraft');
});
