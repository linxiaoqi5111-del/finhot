/** @type {import("prettier").Config & import("prettier-plugin-tailwindcss").PluginOptions} */
export default {
  semi: false,
  singleQuote: false,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: "all",
  objectWrap: "preserve",
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindConfig: "./apps/desktop/tailwind.config.ts",
}
