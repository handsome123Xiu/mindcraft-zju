// Shared by the decision model and the design skill; these are explanations,
// not building templates or an executor.
export const SHAPE_ACTION_GUIDE = Object.freeze({
    point: 'One cell -> place_block.',
    box: 'A solid cuboid of any dimensions, NOT an executable tool. A 7x2x5 box -> TWO 7x5 XZ place_rectangle calls. Equal edges may use place_cube (size 1..8); otherwise fix one axis per rectangle.',
    shell: '3D boundary including floor/roof. Query final part cells and use planar walls/floors split around openings. Never fill the entire bounding volume.',
    frame: 'Planar border with empty interior. Use perimeter rows. A 5x5 frame has 16 cells; a filled 5x5 rectangle has 25 and is invalid for that frame.',
    opening: 'Final subtraction, not a placement. Verify air; explicitly dig observed obstacles when required.',
    replace: 'Changes DESIGN material in a previously defined region. Place only the final material. Does not replace existing world blocks automatically.',
    checklist: 'Name semantic components using shape.part (same title groups shapes). Inspect each part from the world. inspect_part offers valid atomic suggestions after openings/replacements. Execute one chosen suggestion, then read updated checklist. All parts plus global air/solid inspection must pass.'
});
