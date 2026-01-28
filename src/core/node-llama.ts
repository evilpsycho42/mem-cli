export async function importNodeLlamaCpp() {
  return new Function("specifier", "return import(specifier)")("node-llama-cpp");
}
