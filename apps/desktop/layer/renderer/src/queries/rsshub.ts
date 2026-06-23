import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { userActions } from "@follow/store/user/store"
import type { RSSHubUseRequest } from "@follow-app/client-sdk"
import { useMutation } from "@tanstack/react-query"

import { followClient } from "~/lib/api-client"
import { defineQuery } from "~/lib/defineQuery"
import { toastFetchError } from "~/lib/error-parser"

import type { MutationBaseProps } from "./types"

const createLocalModeRSSHubError = () =>
  new Error("RSSHub cloud management is disabled in local RSS mode")

export const useSetRSSHubMutation = ({ onError }: MutationBaseProps = {}) =>
  useMutation({
    mutationFn: (data: RSSHubUseRequest) => {
      if (LOCAL_RSS_MODE) {
        throw createLocalModeRSSHubError()
      }

      return followClient.api.rsshub.use({ ...data })
    },

    onSuccess: (_, variables) => {
      rsshub.list().invalidate()
      rsshub.status().invalidate()

      if (variables.id) {
        rsshub.get({ id: variables.id }).invalidate()
      }
    },

    onError: (error) => {
      onError?.(error)
      toastFetchError(error)
    },
  })

export const useAddRSSHubMutation = ({ onError }: MutationBaseProps = {}) =>
  useMutation({
    mutationFn: ({
      baseUrl,
      accessKey,
      id,
    }: {
      baseUrl: string
      accessKey?: string
      id?: string
    }) => {
      if (LOCAL_RSS_MODE) {
        throw createLocalModeRSSHubError()
      }

      return followClient.api.rsshub.create({
        baseUrl,
        accessKey,
        id,
      })
    },

    onSuccess: (_) => {
      rsshub.list().invalidate()
      rsshub.status().invalidate()
    },

    onError: (error) => {
      onError?.(error)
      toastFetchError(error)
    },
  })

export const useDeleteRSSHubMutation = ({ onError, onSuccess }: MutationBaseProps = {}) =>
  useMutation({
    mutationFn: (id: string) => {
      if (LOCAL_RSS_MODE) {
        throw createLocalModeRSSHubError()
      }

      return followClient.api.rsshub.delete({ id })
    },

    onSuccess: () => {
      onSuccess?.()
    },

    onError: (error) => {
      onError?.(error)
      toastFetchError(error)
    },
  })

export const rsshub = {
  get: ({ id }: { id: string }) =>
    defineQuery(["rsshub", "get", id], async () => {
      if (LOCAL_RSS_MODE) {
        return null
      }

      const res = await followClient.api.rsshub.get({ id })
      return res.data
    }),

  list: () =>
    defineQuery(["rsshub", "list"], async () => {
      if (LOCAL_RSS_MODE) {
        return []
      }

      const res = await followClient.api.rsshub.list()
      userActions.upsertMany(res.data.map((item) => item.owner).filter((item) => item !== null))

      return res.data
    }),

  status: () =>
    defineQuery(["rsshub", "status"], async () => {
      if (LOCAL_RSS_MODE) {
        return null
      }

      const res = await followClient.api.rsshub.status()
      return res.data
    }),
}
