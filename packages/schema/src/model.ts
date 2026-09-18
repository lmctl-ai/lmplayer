export * as Model from "./model"

import { Schema } from "effect"
import { optional } from "./schema"
import { Provider } from "./provider"
import { statics } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("ModelV2.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(optional),
}).annotate({ identifier: "Model.Ref" })
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Family = Schema.String.pipe(Schema.brand("Family"))
export type Family = typeof Family.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.Capabilities" })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})
  .annotate({ identifier: "Model.Cost" })
  .pipe(
    statics((_schema) => ({
      calculate: (
        costs: readonly Cost[] | undefined,
        tokens: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: {
            readonly read: number
            readonly write: number
          }
        },
      ): number => {
        if (!costs || costs.length === 0) return 0
        const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write
        const matchingTier = costs
          .filter((item) => item.tier?.type === "context" && contextTokens > item.tier.size)
          .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
        const costItem = matchingTier ?? costs.find((item) => !item.tier) ?? costs[0]
        if (!costItem) return 0
        const inputRate = Number.isFinite(costItem.input) ? costItem.input : 0
        const outputRate = Number.isFinite(costItem.output) ? costItem.output : 0
        const cacheReadRate = Number.isFinite(costItem.cache.read) ? costItem.cache.read : 0
        const cacheWriteRate = Number.isFinite(costItem.cache.write) ? costItem.cache.write : 0

        const total =
          (tokens.input * inputRate +
            tokens.output * outputRate +
            tokens.reasoning * outputRate +
            tokens.cache.read * cacheReadRate +
            tokens.cache.write * cacheWriteRate) /
          1_000_000

        return Math.max(0, Number.isFinite(total) ? Math.round(total * 100_000_000) / 100_000_000 : 0)
      },
    })),
  )

export const Api = Schema.Union([
  Schema.Struct({
    id: ID,
    ...Provider.AISDK.fields,
  }),
  Schema.Struct({
    id: ID,
    ...Provider.Native.fields,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Model.Api" })
export type Api = typeof Api.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  family: Family.pipe(optional),
  name: Schema.String,
  api: Api,
  capabilities: Capabilities,
  request: Schema.Struct({
    ...Provider.Request.fields,
    variant: Schema.String.pipe(optional),
  }),
  variants: Schema.Struct({
    id: VariantID,
    ...Provider.Request.fields,
  }).pipe(Schema.Array),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(optional),
    output: Schema.Int,
  }),
})
  .annotate({ identifier: "ModelV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (providerID: Provider.ID, modelID: ID) =>
        schema.make({
          id: modelID,
          providerID,
          name: modelID,
          api: { id: modelID, type: "native", settings: {} },
          capabilities: { tools: false, input: [], output: [] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 0, output: 0 },
        }),
    })),
  )
