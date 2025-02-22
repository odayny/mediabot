import * as Sentry from '@sentry/core';
import fastify from 'fastify';
import { Bot, InputFile, webhookCallback } from 'grammy';
import { InlineQueryResult, InputMediaAnimation, InputMediaPhoto, InputMediaVideo } from 'grammy/types';
import lodash from 'lodash';
import { pathToFileURL } from 'node:url';
import * as radash from 'radash';
import * as uuid from 'uuid';
import { z } from 'zod';

import { createCache } from '@mediabot/app/cache';
import { createDefaultLogger } from '@mediabot/app/log';
import { createPrismaClient } from '@mediabot/app/prisma';
import { createRedisManager } from '@mediabot/app/redis';
import * as renderResolver from '@mediabot/app-render/api';
import { bindCallback, createCallback, processCallbacks, submitRequest } from '@mediabot/broker';
import * as instagramResolver from '@mediabot/parser-instagram/api';
import * as redditResolver from '@mediabot/parser-reddit/api';
import * as tiktokResolver from '@mediabot/parser-tiktok/api';
import * as twitterResolver from '@mediabot/parser-twitter/api';
import * as ytdlpResolver from '@mediabot/parser-ytdlp/api';
import { resourcePath } from '@mediabot/resources';
import { render } from '@mediabot/resources/views';

import { env } from './env';
import { getAccountByUser } from './getAccountByUser';
import { mapTwitterMedia } from './twitter';
import { uploadFileToTelegram } from './uploadFileToTelegram';

export const log = createDefaultLogger();

export const redis = createRedisManager({
    url: env.REDIS_URL,
    prefix: env.REDIS_PREFIX,
});

export const prisma = createPrismaClient(env.DATABASE_URL);

export const cache = createCache({
    prisma,
    redis,
    log,
});

export const telegram = new Bot(
    env.BOT_TOKEN,
    {
        client: {
            apiRoot: env.TELEGRAM_API_ROOT,
        },
    },
);

const matchers = [
    instagramResolver.matcher,
    redditResolver.matcher,
    tiktokResolver.matcher,
    twitterResolver.matcher,
    ...ytdlpResolver.matchers,
] as const;

const contextSchema = z.union([
    z.object({
        type: z.literal('chat'),
        chatId: z.number(),
        messageId: z.number().optional(),
        requiresReply: z.boolean(),
    }),
    z.object({
        type: z.literal('inline_query'),
        inlineQueryId: z.string(),
    }),
    z.object({
        type: z.literal('inline'),
        inlineMessageId: z.string(),
        query: z.string(),
    }),
]);

export const processorCallback = createCallback(
    `${ env.SERVICE_NAME }-processor`,
    contextSchema,
    [
        instagramResolver.processor,
        redditResolver.processor,
        tiktokResolver.processor,
        twitterResolver.processor,
        ytdlpResolver.processor,
    ] as const,
);

export const twitterRenderCallback = createCallback(
    `${ env.SERVICE_NAME }-twitter-render`,
    z.intersection(
        contextSchema,
        z.object({
            tweet: z.any(),
        }),
    ),
    [
        renderResolver.processor,
    ] as const,
);

await telegram.init();

const [
    clickToSendFileId,
    notFoundFileId,
    loadingFileId,
] = await Promise.all([
    cache.get(
        `telegram:${ telegram.botInfo.id }:resources:click-to-send`,
        1000 * 60 * 60 * 24,
        z.string(),
        async () => (await uploadFileToTelegram(
            pathToFileURL(resourcePath('telegram/click-to-send.png')),
            'photo',
        )).file_id,
    ),
    cache.get(
        `telegram:${ telegram.botInfo.id }:resources:not-found`,
        1000 * 60 * 60 * 24,
        z.string(),
        async () => (await uploadFileToTelegram(
            pathToFileURL(resourcePath('telegram/not-found.png')),
            'photo',
        )).file_id,
    ),
    cache.get(
        `telegram:${ telegram.botInfo.id }:resources:loading`,
        1000 * 60 * 60 * 24,
        z.string(),
        async () => (await uploadFileToTelegram(
            pathToFileURL(resourcePath('telegram/loading.jpg')),
            'photo',
        )).file_id,
    ),
]);

telegram.on('inline_query', async ctx => {
    const { id, query, from } = ctx.inlineQuery;

    switch (env.INLINE_MODE) {
        case 'request': {
            const prefetch = async () => {
                const telegramAccount = await getAccountByUser({ prisma, redis }, from);

                for (const matcher of [ ...matchers, ytdlpResolver.anyLinkMatcher ]) {
                    for (const regex of matcher.regex) {
                        const match = query.match(regex);
                        if (match === null) {
                            continue;
                        }

                        const matcherQuery = matcher.prepareQuery(match);

                        const request = await submitRequest(
                            {
                                prisma,
                                redis,
                            },
                            matcher.processor,
                            matcherQuery,
                            undefined,
                            {
                                source: 'TELEGRAM',
                            },
                        );

                        await prisma.telegramRequest.create({
                            data: {
                                query: query,
                                type: 'PREFETCH',
                                request: {
                                    connect: { id: request.id },
                                },
                                account: {
                                    connect: { id: telegramAccount.id },
                                },
                            },
                        });

                        return;
                    }
                }
            };

            await Promise.all([
                prefetch(),
                ctx.answerInlineQuery([
                    {
                        type: 'photo',
                        id: uuid.v4(),
                        title: ctx.inlineQuery.query,
                        photo_file_id: clickToSendFileId,
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: 'Loading...',
                                        callback_data: 'loading',
                                    },
                                ],
                            ],
                        },
                    },
                ], {
                    cache_time: 0,
                    is_personal: true,
                }),
            ]);

            break;
        }

        case 'immediate': {
            const telegramAccount = await getAccountByUser({ prisma, redis }, from);

            for (const matcher of [ ...matchers, ytdlpResolver.anyLinkMatcher ]) {
                for (const regex of matcher.regex) {
                    const match = query.match(regex);
                    if (match === null) {
                        continue;
                    }

                    const matcherQuery = matcher.prepareQuery(match);

                    const request = await submitRequest(
                        { prisma, redis },
                        matcher.processor,
                        matcherQuery,
                        bindCallback(processorCallback, {
                            type: 'inline_query',
                            inlineQueryId: id,
                        }),
                        {
                            source: 'TELEGRAM',
                        },
                    );

                    await prisma.telegramRequest.create({
                        data: {
                            query: query,
                            type: 'INLINE',
                            request: {
                                connect: { id: request.id },
                            },
                            account: {
                                connect: { id: telegramAccount.id },
                            },
                        },
                    });

                    return;
                }
            }

            await ctx.answerInlineQuery([], {
                cache_time: 0,
                is_personal: true,
            });

            break;
        }
    }
});

telegram.on('message', async ctx => {
    log.debug(ctx.message, 'Received message');

    if (!ctx.message.text) {
        return;
    }

    const telegramAccount = await getAccountByUser({ prisma, redis }, ctx.message.from);

    const { query, replyToId, isImplicit } = ctx.message.chat.type === 'private'
        ? {
            query: ctx.message.text,
            replyToId: undefined,
            isImplicit: false,
        }
        : ctx.message.text.indexOf(`@${ telegram.botInfo.username }`) !== -1
            ? (ctx.message.reply_to_message && ctx.message.text.trim() === `@${ telegram.botInfo.username }` && 'text' in ctx.message.reply_to_message
                ? {
                    query: ctx.message.reply_to_message.text ?? '',
                    replyToId: ctx.message.reply_to_message.message_id,
                    isImplicit: false,
                }
                : {
                    query: ctx.message.text,
                    replyToId: ctx.message.message_id,
                    isImplicit: false,
                }
            )
            : {
                query: ctx.message.text,
                replyToId: ctx.message.message_id,
                isImplicit: true,
            };

    try {
        for (const matcher of [
            ...matchers,
            ...isImplicit ? [] : [ ytdlpResolver.anyLinkMatcher ],
        ]) {
            for (const regex of matcher.regex) {
                const match = query.match(regex);
                if (match === null) {
                    continue;
                }

                const matcherQuery = matcher.prepareQuery(match);

                const request = await submitRequest(
                    { prisma, redis },
                    matcher.processor,
                    matcherQuery,
                    bindCallback(processorCallback, {
                        type: 'chat',
                        chatId: ctx.message.chat.id,
                        messageId: replyToId,
                        requiresReply: !isImplicit,
                    }),
                    {
                        source: 'TELEGRAM',
                    },
                );

                await prisma.telegramRequest.create({
                    data: {
                        query: query,
                        type: 'MESSAGE',
                        request: {
                            connect: { id: request.id },
                        },
                        account: {
                            connect: { id: telegramAccount.id },
                        },
                    },
                });

                await ctx.replyWithChatAction(lodash.shuffle([
                    'typing',
                    'upload_photo',
                    'record_video',
                    'upload_video',
                    'record_voice',
                    'upload_voice',
                    'upload_document',
                    'choose_sticker',
                    'find_location',
                    'record_video_note',
                    'upload_video_note',
                ] as const)[ 0 ]);

                return;
            }
        }
    } catch (e) {
        log.error(e);
    }

    await replyNotFound({
        type: 'chat',
        chatId: ctx.message.chat.id,
        messageId: ctx.message.message_id,
        requiresReply: !isImplicit,
    });
});

telegram.on('chosen_inline_result', async ctx => {
    log.debug(ctx.chosenInlineResult, 'Received chosen inline result');

    if (env.INLINE_MODE === 'immediate') {
        return;
    }

    const { query, from } = ctx.chosenInlineResult;

    const telegramAccount = await getAccountByUser({ prisma, redis }, from);

    await ctx.api.editMessageMediaInline(
        ctx.chosenInlineResult.inline_message_id!,
        {
            type: 'photo',
            media: loadingFileId,
            caption: query,
        },
    );

    try {
        for (const matcher of [ ...matchers, ytdlpResolver.anyLinkMatcher ]) {
            for (const regex of matcher.regex) {
                const match = query.match(regex);
                if (match === null) {
                    continue;
                }

                const matcherQuery = matcher.prepareQuery(match);

                const request = await submitRequest(
                    { prisma, redis },
                    matcher.processor,
                    matcherQuery,
                    bindCallback(processorCallback, {
                        type: 'inline',
                        inlineMessageId: ctx.chosenInlineResult.inline_message_id!,
                        query,
                    }),
                    {
                        source: 'TELEGRAM',
                    },
                );

                await prisma.telegramRequest.create({
                    data: {
                        query: query,
                        type: 'INLINE',
                        request: {
                            connect: { id: request.id },
                        },
                        account: {
                            connect: { id: telegramAccount.id },
                        },
                    },
                });

                return;
            }
        }
    } catch (e) {
        log.error(e);
    }

    await replyNotFound({
        type: 'inline',
        inlineMessageId: ctx.chosenInlineResult.inline_message_id!,
        query,
    });
});

telegram.catch(
    err => {
        Sentry.captureException(err);
        log.error(err);
    },
);

const processDefaultMediaCallback = async (
    context: z.TypeOf<typeof contextSchema>,
    title: string | null,
    url: string | null,
    items: (
        | {
            type: 'photo',
            url: string | InputFile,
            size?: {
                width: number,
                height: number,
            },
        }
        | {
            type: 'gif',
            url: string | InputFile,
            size?: {
                width: number,
                height: number,
            },
        }
        | {
            type: 'video',
            url: string | InputFile,
            size?: {
                width: number,
                height: number,
            },
            duration?: number,
        }
    )[],
) => {
    const caption = title !== null || url !== null
        ? [ title, url ].filter(Boolean).join('\n\n').substring(0, 1024)
        : undefined;

    switch (context.type) {
        case 'chat': {
            const inputMedia: Array<InputMediaPhoto | InputMediaAnimation | InputMediaVideo> = items.map(media => {
                switch (media.type) {
                    case 'photo':
                        return {
                            type: 'photo',
                            media: media.url,

                            ...media.size,
                        } satisfies InputMediaPhoto;

                    case 'gif':
                        return {
                            type: 'animation',
                            media: media.url,

                            ...media.size,
                        } satisfies InputMediaAnimation;

                    case 'video':
                        return {
                            type: 'video',
                            media: media.url,

                            ...media.size,

                            duration: media.duration !== undefined
                                ? Math.round(media.duration)
                                : undefined,
                        } satisfies InputMediaVideo;
                }
            });

            const chunks: Array<Array<InputMediaPhoto | InputMediaVideo> | InputMediaAnimation> = [];
            let currentChunk: Array<InputMediaPhoto | InputMediaVideo> = [];
            for (const item of inputMedia) {
                if (item.type === 'photo' || item.type === 'video') {
                    currentChunk.push(item);
                    if (currentChunk.length === 10) {
                        chunks.push(currentChunk);
                        currentChunk = [];
                    }
                    continue;
                }

                if (currentChunk.length !== 0) {
                    chunks.push(currentChunk);
                    currentChunk = [];
                }

                chunks.push(item);
            }
            if (currentChunk.length !== 0) {
                chunks.push(currentChunk);
                currentChunk = [];
            }

            for (const chunk of chunks) {
                if (chunk instanceof Array) {
                    await telegram.api.sendMediaGroup(
                        context.chatId,
                        [
                            {
                                ...chunk[ 0 ],
                                caption,
                            },
                            ...chunk.slice(1),
                        ],
                        {
                            reply_to_message_id: context.messageId,
                            disable_notification: true,
                        },
                    );
                } else {
                    const { type, media, ...extra } = chunk;
                    await telegram.api.sendAnimation(
                        context.chatId,
                        media,
                        {
                            ...extra,
                            caption,
                            reply_to_message_id: context.messageId,
                            disable_notification: true,
                        },
                    );
                }
            }
            break;
        }

        case 'inline_query': {
            const uploadPhoto = async (file: InputFile): Promise<string> => {
                const temporaryMessage = await telegram.api.sendPhoto(env.TEMPORARY_CHAT_ID, file);

                telegram.api.deleteMessage(env.TEMPORARY_CHAT_ID, temporaryMessage.message_id).catch(
                    error => log.error(error, 'Failed to delete temporary message'),
                );

                return temporaryMessage.photo[ 0 ].file_id;
            };

            const uploadGif = async (
                file: InputFile | string,
                size?: { width: number, height: number },
            ): Promise<string> => {
                const temporaryMessage = await telegram.api.sendAnimation(env.TEMPORARY_CHAT_ID, file, {
                    ...size,
                });

                log.info(temporaryMessage);

                telegram.api.deleteMessage(env.TEMPORARY_CHAT_ID, temporaryMessage.message_id).catch(
                    error => log.error(error, 'Failed to delete temporary message'),
                );

                return temporaryMessage.animation.file_id;
            };

            const uploadVideo = async (
                file: InputFile | string,
                size?: { width: number, height: number },
            ): Promise<string> => {
                const temporaryMessage = await telegram.api.sendVideo(env.TEMPORARY_CHAT_ID, file, {
                    ...size,
                    supports_streaming: true,
                });

                telegram.api.deleteMessage(env.TEMPORARY_CHAT_ID, temporaryMessage.message_id).catch(
                    error => log.error(error, 'Failed to delete temporary message'),
                );

                return temporaryMessage.video.file_id;
            };

            await telegram.api.answerInlineQuery(context.inlineQueryId, [
                ...await Promise.all(items.map(async (item): Promise<InlineQueryResult> => {
                    switch (item.type) {
                        case 'photo': {
                            return {
                                type: 'photo',
                                id: uuid.v4(),
                                caption,
                                ...typeof item.url !== 'string'
                                    ? {
                                        photo_file_id: await uploadPhoto(item.url),
                                    }
                                    : {
                                        photo_url: item.url,
                                        thumbnail_url: item.url,
                                    },
                            };
                        }

                        case 'gif': {
                            const fileId = await uploadGif(item.url, item.size);
                            return {
                                type: 'gif',
                                id: uuid.v4(),
                                caption,
                                gif_file_id: fileId,
                            };
                        }

                        case 'video':
                            return {
                                type: 'video',
                                id: uuid.v4(),
                                caption,
                                title: caption ?? '',
                                video_file_id: await uploadVideo(item.url, item.size),
                            };
                    }
                })),
            ], {
                is_personal: false,
                cache_time: process.env.NODE_ENV === 'development' ?
                    1 :
                    60,
            });

            break;
        }

        case 'inline': {
            const media = items[ 0 ];

            switch (media.type) {
                case 'photo': {
                    let file = media.url;

                    if (typeof file !== 'string') {
                        const temporaryMessage = await telegram.api.sendPhoto(env.TEMPORARY_CHAT_ID, file);

                        telegram.api.deleteMessage(env.TEMPORARY_CHAT_ID, temporaryMessage.message_id).catch(
                            error => log.error(error, 'Failed to delete temporary message'),
                        );

                        file = temporaryMessage.photo[ 0 ].file_id;
                    }

                    await telegram.api.editMessageMediaInline(context.inlineMessageId, {
                        type: 'photo',
                        media: media.url,
                        caption,
                    });
                    break;
                }

                case 'video': {
                    let file = media.url;

                    if (typeof file !== 'string') {
                        const temporaryMessage = await telegram.api.sendVideo(env.TEMPORARY_CHAT_ID, file, {
                            ...media.size,
                            supports_streaming: true,
                        });

                        telegram.api.deleteMessage(env.TEMPORARY_CHAT_ID, temporaryMessage.message_id).catch(
                            error => log.error(error, 'Failed to delete temporary message'),
                        );

                        file = temporaryMessage.video.file_id;
                    }

                    await telegram.api.editMessageMediaInline(context.inlineMessageId, {
                        type: 'video',
                        media: file,
                        caption,
                        duration: media.duration !== undefined
                            ? Math.round(media.duration)
                            : undefined,
                        ...media.size,
                        supports_streaming: true,
                    });
                    break;
                }
            }
            break;
        }
    }
};

const replyNotFound = async (ctx: z.TypeOf<typeof contextSchema>) => {
    switch (ctx.type) {
        case 'chat':
            if (ctx.requiresReply) {
                await telegram.api.sendMessage(ctx.chatId, 'Not found', {
                    reply_to_message_id: ctx.messageId,
                });
            }
            break;

        case 'inline_query':
            await telegram.api.answerInlineQuery(ctx.inlineQueryId, []);
            break;

        case 'inline':
            await telegram.api.editMessageMediaInline(ctx.inlineMessageId, {
                type: 'photo',
                media: notFoundFileId,
                caption: ctx.query,
            });
            break;
    }
};

const spawn = async (fn: () => Promise<void>) => {
    fn().catch(
        error => {
            Sentry.captureException(error);
            log.error(error);
        },
    );
};

log.info('Starting Telegram bot...');

export const main = async (process: NodeJS.Process, abortSignal: AbortSignal) => await radash.defer(async defer => {
    await prisma.$connect();
    defer(async () => await prisma.$disconnect());
    defer(() => redis.client.disconnect());

    switch (env.BOT_MODE) {
        case 'polling': {
            defer(async () => await telegram.stop());

            telegram.start();
            break;
        }

        case 'webhook': {
            const app = fastify({
                logger: true,
            });

            app.get('/health', async () => {
                return {
                    status: 'ok',
                };
            });

            app.all(
                env.BOT_WEBHOOK_PATH,
                webhookCallback(telegram, 'fastify'),
            );

            defer(async () => await app.close());

            app.listen({
                host: '0.0.0.0',
                port: env.BOT_WEBHOOK_PORT,
            });

            log.info(`Starting Telegram bot webhook server on port ${ env.BOT_WEBHOOK_PORT }...`);
            break;
        }
    }

    await Promise.all([
        (async () => {
            for await (const item of processCallbacks({
                prisma,
                redis,
            }, processorCallback, { abortSignal })) {
                log.debug(item, 'Processing callback');

                spawn(async () => {
                    if ('error' in item) {
                        await replyNotFound(item.context);
                        return;
                    }

                    try {
                        switch (item.name) {
                            case 'instagram':
                                await processDefaultMediaCallback(
                                    item.context,
                                    item.result.title,
                                    item.result.url,
                                    await Promise.all(item.result.media.map(async media => ({
                                        type: media.type,
                                        url: media.data.type === 'url'
                                            ? media.data.url
                                            : new InputFile(
                                                (await redis.client.getBuffer(`${ redis.prefix }:${ media.data.ref }`))!,
                                                media.data.name,
                                            ),
                                        size: media.size,
                                    }))),
                                );
                                break;

                            case 'reddit':
                                await processDefaultMediaCallback(
                                    item.context,
                                    item.result.title,
                                    item.result.url,
                                    await Promise.all(item.result.media.map(async media => {
                                        const input = media.data.type === 'url'
                                            ? media.data.url
                                            : new InputFile(
                                                (await redis.client.getBuffer(`${ redis.prefix }:${ media.data.ref }`))!,
                                                media.data.name,
                                            );

                                        switch (media.type) {
                                            case 'photo':
                                                return {
                                                    type: 'photo',
                                                    url: input,
                                                    size: media.size,
                                                };

                                            case 'gif':
                                                return {
                                                    type: 'gif',
                                                    url: input,
                                                    size: media.size,
                                                };

                                            case 'video':
                                                return {
                                                    type: 'video',
                                                    url: input,
                                                    size: media.size,
                                                    duration: media.duration,
                                                };
                                        }
                                    })),
                                );
                                break;

                            case 'tiktok':
                                switch (item.result.media.type) {
                                    case 'photos':
                                        await processDefaultMediaCallback(
                                            item.context,
                                            item.result.title,
                                            item.result.url,
                                            await Promise.all(item.result.media.items.map(async media => ({
                                                type: 'photo',
                                                url: media.data.type === 'url'
                                                    ? media.data.url
                                                    : new InputFile(
                                                        (await redis.client.getBuffer(`${ redis.prefix }:${ media.data.ref }`))!,
                                                        media.data.name,
                                                    ),
                                                size: media.size,
                                            }))),
                                        );
                                        break;

                                    case 'video': {
                                        const data = item.result.media.data.type === 'url'
                                            ? item.result.media.data.url
                                            : new InputFile(
                                                (await redis.client.getBuffer(`${ redis.prefix }:${ item.result.media.data.ref }`))!,
                                                item.result.media.data.name,
                                            );

                                        await processDefaultMediaCallback(
                                            item.context,
                                            item.result.title,
                                            item.result.url,
                                            [
                                                {
                                                    type: 'video',
                                                    url: data,
                                                    size: item.result.media.size,
                                                    duration: item.result.media.duration,
                                                },
                                            ],
                                        );
                                    }
                                }
                                break;

                            case 'twitter': {
                                const { chain, status } = item.result;

                                if (item.context.type === 'inline' && status.extended_entities?.media) {
                                    const media = status.extended_entities?.media[ 0 ];

                                    await processDefaultMediaCallback(
                                        item.context,
                                        status.full_text,
                                        `https://twitter.com/${ status.user.screen_name }/status/${ status.id_str }`,
                                        [
                                            mapTwitterMedia(media),
                                        ],
                                    );
                                } else {
                                    const content = await render('twitter/preview.twig', {
                                        chain,
                                        tweet: status,
                                    });

                                    await submitRequest(
                                        { prisma, redis },
                                        renderResolver.processor,
                                        {
                                            content: Buffer.from(content).toString('base64'),
                                            selector: '#root',
                                        },
                                        bindCallback(twitterRenderCallback, {
                                            ...item.context,
                                            tweet: status,
                                        }),
                                    );
                                }
                                break;
                            }

                            case 'ytdlp': {
                                const { title, url, media } = item.result;

                                const mediaData = new Map<string, Buffer>();

                                await Promise.all(
                                    media.map(async item => {
                                        const buffer = await redis.client.getBuffer(`${ redis.prefix }:${ item.ref }`);
                                        if (buffer === null) {
                                            throw new Error(`Media "${ item.ref }" not found`);
                                        }

                                        mediaData.set(
                                            item.ref,
                                            buffer,
                                        );
                                    }),
                                );

                                await processDefaultMediaCallback(
                                    item.context,
                                    title,
                                    url,
                                    media.map(({ ref, ...item }) => ({
                                        ...item,
                                        url: new InputFile(
                                            mediaData.get(ref)!,
                                        ),
                                    })),
                                );
                                break;
                            }
                        }
                    } catch (error) {
                        log.error(error, 'Failed to process callback');

                        await replyNotFound(item.context);
                    }
                });
            }
        })(),

        (async () => {
            for await (const item of processCallbacks({ prisma, redis }, twitterRenderCallback, { abortSignal })) {
                log.debug(item, 'Processing twitter callback');

                spawn(async () => {
                    if ('error' in item) {
                        await replyNotFound(item.context);
                        return;
                    }

                    const { tweet } = item.context;

                    try {
                        await processDefaultMediaCallback(
                            item.context,
                            null,
                            `https://twitter.com/${ tweet.user.screen_name }/status/${ tweet.id_str }`,
                            [
                                {
                                    type: 'photo',
                                    url: new InputFile(
                                        (await redis.client.getBuffer(`${ redis.prefix }:${ item.result.ref }`))!,
                                        'image.png',
                                    ),
                                    size: {
                                        width: item.result.width,
                                        height: item.result.height,
                                    },
                                },

                                ...lodash.get(tweet, 'extended_entities.media', []).map(
                                    mapTwitterMedia,
                                ),

                                ...lodash.get(tweet, 'quoted_status.extended_entities.media', []).map(
                                    mapTwitterMedia,
                                ),
                            ],
                        );
                    } catch (error) {
                        log.error(error, 'Failed to process twitter callback');

                        await replyNotFound(item.context);
                    }
                });
            }
        })(),
    ]);

    log.info('Exited gracefully');

    return 0;
});
