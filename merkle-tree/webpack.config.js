const path = require("path");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = {
  entry: {
    MerkleTree: "./src/index.ts",
    "MerkleTree.min": "./src/index.ts",
  },
  output: {
    path: path.resolve(__dirname, "lib-browser"),
    filename: "index.js",
    libraryTarget: "umd",
    library: "MerkleTree",
    umdNamedDefine: true,
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
    fallback: {
      assert: require.resolve("assert/"),
      buffer: require.resolve("buffer/"),
      stream: require.resolve("stream-browserify"),
    },
  },
  devtool: "source-map",
  plugins: [new CleanWebpackPlugin()],
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        include: /\.min\.js$/,
        parallel: true,
      }),
    ],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
};

// const commonConfig = {
//   entry: "./src/index.ts",
//   module: {
//     rules: [
//       {
//         test: /\.tsx?$/,
//         use: "ts-loader",
//         exclude: /node_modules/,
//       },
//     ],
//   },
//   devtool: "source-map",
//   externals: ["ethereumjs-util", "web3-utils"],
// };

// module.exports = [
//   {
//     output: {
//       path: path.resolve(__dirname, "dist"),
//     },
//     plugins: [new CleanWebpackPlugin()],
//   },
//   {
//     ...commonConfig,
//     target: "web",
//     output: {
//       path: path.resolve(__dirname, "dist"),
//       filename: "index.amd.js",
//       library: "MerkleTree",
//       libraryTarget: "amd",
//     },
//     resolve: {
//       extensions: [".ts", ".js"],
//     },
//   },
//   {
//     ...commonConfig,
//     target: "node",
//     output: {
//       path: path.resolve(__dirname, "dist"),
//       filename: "index.commonjs.js",
//       library: "MerkleTree",
//       libraryTarget: "commonjs2",
//     },
//     resolve: {
//       extensions: [".ts", ".js"],
//     },
//   },
// ];
