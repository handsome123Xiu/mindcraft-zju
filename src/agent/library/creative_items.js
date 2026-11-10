import itemLoader from 'prismarine-item';

// Generated code sometimes supplies a plain item descriptor. Construct the actual
// version-specific Item and validate BEFORE Mineflayer marks the slot as busy.
export function installCreativeItemAdapter(bot) {
    if (!bot.creative?.setInventorySlot || bot.creative.setInventorySlot.itemAdapter) return;
    const Item = itemLoader(bot.registry);
    const original = bot.creative.setInventorySlot.bind(bot.creative);
    async function setInventorySlot(slot, descriptor, waitTimeout) {
        let item = descriptor;
        if (item != null) {
            if (!Number.isInteger(item.type) || !bot.registry.items[item.type]) throw new Error('Creative item: invalid item type');
            if (!Number.isInteger(item.count) || item.count < 1 || item.count > 64) throw new Error('Creative item: count must be 1-64');
            if (!(item instanceof Item)) {
                item = new Item(descriptor.type, descriptor.count, descriptor.metadata ?? 0, descriptor.nbt ?? null);
                // Preserve supplied component data; constructor fills missing fields.
                for (const key of ['components', 'removedComponents']) {
                    if (descriptor[key] !== undefined) item[key] = descriptor[key];
                }
            }
            if (bot.registry.supportFeature('itemsWithComponents') &&
                (!Array.isArray(item.components) || !Array.isArray(item.removedComponents))) {
                throw new Error('Creative item: components and removedComponents must be arrays');
            }
            Item.toNotch(item);
        }
        return original(slot, item, waitTimeout);
    }
    setInventorySlot.itemAdapter = true;
    bot.creative.setInventorySlot = setInventorySlot;
}
