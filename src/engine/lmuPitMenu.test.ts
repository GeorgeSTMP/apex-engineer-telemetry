import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTirePlanToLmuPitMenu } from './lmuPitMenu';

function makeMockLmuPitMenu() {
  return [
    {
      name: 'FL TIRE',
      currentSetting: 0,
      settings: [
        { text: 'No Change' },
        { text: 'Soft' },
        { text: 'Medium' },
        { text: 'Hard' },
        { text: 'Wet' },
      ],
    },
    {
      name: 'FR TIRE',
      currentSetting: 0,
      settings: [
        { text: 'No Change' },
        { text: 'Soft' },
        { text: 'Medium' },
        { text: 'Hard' },
        { text: 'Wet' },
      ],
    },
    {
      name: 'RL TIRE',
      currentSetting: 0,
      settings: [
        { text: 'No Change' },
        { text: 'Soft' },
        { text: 'Medium' },
        { text: 'Hard' },
        { text: 'Wet' },
      ],
    },
    {
      name: 'RR TIRE',
      currentSetting: 0,
      settings: [
        { text: 'No Change' },
        { text: 'Soft' },
        { text: 'Medium' },
        { text: 'Hard' },
        { text: 'Wet' },
      ],
    },
    {
      name: 'REPAIR DAMAGE',
      currentSetting: 0,
      settings: [{ text: 'Do Not Repair' }, { text: 'Repair Body' }, { text: 'Repair All' }],
    },
    {
      name: 'REPLACE BRAKES',
      currentSetting: 0,
      settings: [{ text: 'No' }, { text: 'Yes' }],
    },
  ];
}

test('applyTirePlanToLmuPitMenu sets 4x Soft and leaves brakes untouched', () => {
  const menu = makeMockLmuPitMenu();
  const res = applyTirePlanToLmuPitMenu(menu, {
    tireAction: 'change_all',
    tireCompound: 'Soft',
    repairsRecommended: false,
    pitTireCallHeadline: '4x Soft',
  });
  const updated = res.updatedMenu as Array<{ name: string; currentSetting: number }>;
  assert.equal(updated[0].currentSetting, 1);
  assert.equal(updated[1].currentSetting, 1);
  assert.equal(updated[2].currentSetting, 1);
  assert.equal(updated[3].currentSetting, 1);
  assert.equal(updated[4].currentSetting, 0);
  assert.equal(updated[5].currentSetting, 0); // REPLACE BRAKES untouched
  assert.equal(res.changedCount, 4);
});

test('applyTirePlanToLmuPitMenu sets 2x Front Medium while keeping rear tires at No Change', () => {
  const menu = makeMockLmuPitMenu();
  menu[2].currentSetting = 2; // previously Medium
  menu[3].currentSetting = 2;
  const res = applyTirePlanToLmuPitMenu(menu, {
    tireAction: 'change_fronts',
    tireCompound: 'Medium',
    repairsRecommended: false,
    pitTireCallHeadline: '2x Front Medium (~7s)',
  });
  const updated = res.updatedMenu as Array<{ name: string; currentSetting: number }>;
  assert.equal(updated[0].currentSetting, 2);
  assert.equal(updated[1].currentSetting, 2);
  assert.equal(updated[2].currentSetting, 0);
  assert.equal(updated[3].currentSetting, 0);
});

test('applyTirePlanToLmuPitMenu enables Repair All when crash repairsRecommended is true', () => {
  const menu = makeMockLmuPitMenu();
  const res = applyTirePlanToLmuPitMenu(menu, {
    tireAction: 'change_all',
    tireCompound: 'Hard',
    repairsRecommended: true,
    pitTireCallHeadline: '4x Hard',
  });
  const updated = res.updatedMenu as Array<{ name: string; currentSetting: number }>;
  assert.equal(updated[0].currentSetting, 3); // Hard
  assert.equal(updated[4].currentSetting, 2); // Repair All
  assert.equal(updated[5].currentSetting, 0); // Brakes untouched
});
