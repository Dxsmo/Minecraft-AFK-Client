declare module "minecraft-assets" {
  interface TextureEntry {
    name: string;
    /** Data URL (`data:image/png;base64,...`) of the texture. */
    texture: string;
  }
  interface McAssets {
    directory: string;
    version: string;
    textureContent: Record<string, TextureEntry>;
    getTexture(name: string): string | undefined;
  }
  /** Returns the asset bundle for a Minecraft version, or null if unavailable. */
  function mcAssets(version: string): McAssets | null;
  export = mcAssets;
}
