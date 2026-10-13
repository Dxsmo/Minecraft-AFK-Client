import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type Codec = {
  readCtx: Record<string, (buffer: Buffer, offset: number) => { value: unknown; size: number }>;
  writeCtx: Record<string, (value: unknown, buffer: Buffer, offset: number) => number>;
  sizeOfCtx: Record<string, (value: unknown) => number>;
};
const nbt = require("prismarine-nbt") as {
  protos: { littleVarint: Codec };
  addTypesToCompiler(type: string, compiler: unknown): void;
};

let corrected: Codec | undefined;

/** Network NBT uses ZigZag VarInts for every Int/Long, including array elements.
 * prismarine-nbt 2.8.0 incorrectly uses fixed-width LE elements in these arrays.
 * Replace only the network array codecs in the existing context objects:
 * bedrock-protocol may already have captured the littleVarint proto by reference. */
export function installBedrockNetworkNbtArrays(): void {
  if (!corrected) {
    const { ProtoDefCompiler } = require("protodef").Compiler;
    const compiler = new ProtoDefCompiler();
    // ProtoDef keeps the first non-native definition, so register corrections
    // before importing the library's remaining network NBT types.
    compiler.addTypesToCompile({
      intArray: ["array", { countType: "zigzag32", type: "zigzag32" }],
      longArray: ["array", { countType: "zigzag32", type: "zigzag64" }],
    });
    nbt.addTypesToCompiler("littleVarint", compiler);
    corrected = compiler.compileProtoDefSync() as Codec;
  }
  const codec = corrected;
  const target = nbt.protos.littleVarint;
  for (const name of ["intArray", "longArray"]) {
    target.readCtx[name] = (buffer, offset) => {
      const count = codec.readCtx.zigzag32(buffer, offset).value as number;
      if (count < 0) throw new Error(`Negative network NBT ${name} length: ${count}`);
      return codec.readCtx[name](buffer, offset);
    };
    target.writeCtx[name] = codec.writeCtx[name];
    target.sizeOfCtx[name] = codec.sizeOfCtx[name];
  }
}
