/* models.js
   Model configuration for the game.
   Put your .glb files in assets/models/ and set the paths below.
   You can also paste a Base64 data URI instead of a path (works the same).
   Example of Base64 form:
   MODELS.PLAYER = "data:model/gltf-binary;base64,AAA...";
*/

window.MODELS = {
  PLAYER: "assets/models/player.glb",   // expected to include Idle and Walk clips
  NPC:    "assets/models/npc.glb",      // Idle clip optional
  TREE:   "assets/models/tree.glb",     // instanced across the map
  CASTLE: "assets/models/castle.glb"    // gatehouse + towers + walls
};
