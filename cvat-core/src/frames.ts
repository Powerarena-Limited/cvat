// Copyright (C) 2021-2022 Intel Corporation
// Copyright (C) 2022-2023 CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import _ from 'lodash';
import {
    FrameDecoder, BlockType, DimensionType, ChunkQuality, decodeContextImages, RequestOutdatedError,
} from 'cvat-data';
import PluginRegistry from './plugins';
import serverProxy, { RawFramesMetaData } from './server-proxy';
import { Exception, ArgumentError, DataError } from './exceptions';

// frame storage by job id
const frameDataCache: Record<string, {
    meta: Omit<RawFramesMetaData, 'deleted_frames'> & { deleted_frames: Record<number, boolean> };
    chunkSize: number;
    mode: 'annotation' | 'interpolation';
    startFrame: number;
    stopFrame: number;
    decodeForward: boolean;
    forwardStep: number;
    latestFrameDecodeRequest: number | null;
    latestContextImagesRequest: number | null;
    provider: FrameDecoder;
    decodedBlocksCacheSize: number;
    activeChunkRequest: Promise<void> | null;
    activeContextRequest: Promise<Record<number, ImageBitmap>> | null;
    contextCache: Record<number, {
        data: Record<number, ImageBitmap>;
        timestamp: number;
        size: number;
    }>;
    getChunk: (chunkNumber: number, quality: ChunkQuality) => Promise<ArrayBuffer>;
}> = {};

export class FramesMetaData {
    public chunkSize: number;
    public deletedFrames: number[];
    public includedFrames: number[];
    public frameFilter: string;
    public frames: {
        width: number;
        height: number;
        name: string;
        related_files: number;
    }[];
    public imageQuality: number;
    public size: number;
    public startFrame: number;
    public stopFrame: number;

    constructor(initialData: RawFramesMetaData) {
        const data: RawFramesMetaData = {
            chunk_size: undefined,
            deleted_frames: [],
            included_frames: [],
            frame_filter: undefined,
            frames: [],
            image_quality: undefined,
            size: undefined,
            start_frame: undefined,
            stop_frame: undefined,
        };

        for (const property in data) {
            if (Object.prototype.hasOwnProperty.call(data, property) && property in initialData) {
                data[property] = initialData[property];
            }
        }

        Object.defineProperties(
            this,
            Object.freeze({
                chunkSize: {
                    get: () => data.chunk_size,
                },
                deletedFrames: {
                    get: () => data.deleted_frames,
                },
                includedFrames: {
                    get: () => data.included_frames,
                },
                frameFilter: {
                    get: () => data.frame_filter,
                },
                frames: {
                    get: () => data.frames,
                },
                imageQuality: {
                    get: () => data.image_quality,
                },
                size: {
                    get: () => data.size,
                },
                startFrame: {
                    get: () => data.start_frame,
                },
                stopFrame: {
                    get: () => data.stop_frame,
                },
            }),
        );
    }
}

export class FrameData {
    public readonly filename: string;
    public readonly width: number;
    public readonly height: number;
    public readonly number: number;
    public readonly relatedFiles: number;
    public readonly deleted: boolean;
    public readonly jobID: number;

    constructor({
        width,
        height,
        name,
        jobID,
        frameNumber,
        deleted,
        related_files: relatedFiles,
    }) {
        Object.defineProperties(
            this,
            Object.freeze({
                filename: {
                    value: name,
                    writable: false,
                },
                width: {
                    value: width,
                    writable: false,
                },
                height: {
                    value: height,
                    writable: false,
                },
                jobID: {
                    value: jobID,
                    writable: false,
                },
                number: {
                    value: frameNumber,
                    writable: false,
                },
                relatedFiles: {
                    value: relatedFiles,
                    writable: false,
                },
                deleted: {
                    value: deleted,
                    writable: false,
                },
            }),
        );
    }

    async data(onServerRequest = () => {}): Promise<ImageBitmap | Blob> {
        const result = await PluginRegistry.apiWrapper.call(this, FrameData.prototype.data, onServerRequest);
        return result;
    }
}

Object.defineProperty(FrameData.prototype.data, 'implementation', {
    value(this: FrameData, onServerRequest) {
        return new Promise<{
            renderWidth: number;
            renderHeight: number;
            imageData: ImageBitmap | Blob;
        } | Blob>((resolve, reject) => {
            const {
                provider, chunkSize, stopFrame, decodeForward, forwardStep, decodedBlocksCacheSize,
            } = frameDataCache[this.jobID];

            const requestId = +_.uniqueId();
            const chunkNumber = Math.floor(this.number / chunkSize);
            const frame = provider.frame(this.number);

            function findTheNextNotDecodedChunk(searchFrom: number): number {
                let firstFrameInNextChunk = searchFrom + forwardStep;
                let nextChunkNumber = Math.floor(firstFrameInNextChunk / chunkSize);
                while (nextChunkNumber === chunkNumber) {
                    firstFrameInNextChunk += forwardStep;
                    nextChunkNumber = Math.floor(firstFrameInNextChunk / chunkSize);
                }

                if (provider.isChunkCached(nextChunkNumber)) {
                    return findTheNextNotDecodedChunk(firstFrameInNextChunk);
                }

                return nextChunkNumber;
            }

            if (frame) {
                if (decodeForward && decodedBlocksCacheSize > 1 && !frameDataCache[this.jobID].activeChunkRequest) {
                    const nextChunkNumber = findTheNextNotDecodedChunk(this.number);
                    const predecodeChunksMax = Math.floor(decodedBlocksCacheSize / 2);
                    if (nextChunkNumber * chunkSize <= stopFrame &&
                        nextChunkNumber <= chunkNumber + predecodeChunksMax) {
                        provider.cleanup(1);
                        frameDataCache[this.jobID].activeChunkRequest = new Promise((resolveForward) => {
                            const releasePromise = (): void => {
                                resolveForward();
                                frameDataCache[this.jobID].activeChunkRequest = null;
                            };

                            frameDataCache[this.jobID].getChunk(
                                nextChunkNumber, ChunkQuality.COMPRESSED,
                            ).then((chunk: ArrayBuffer) => {
                                provider.requestDecodeBlock(
                                    chunk,
                                    nextChunkNumber * chunkSize,
                                    Math.min(stopFrame, (nextChunkNumber + 1) * chunkSize - 1),
                                    () => {},
                                    releasePromise,
                                    releasePromise,
                                );
                            }).catch(() => {
                                releasePromise();
                            });
                        });
                    }
                }

                resolve({
                    renderWidth: this.width,
                    renderHeight: this.height,
                    imageData: frame,
                });
                return;
            }

            onServerRequest();
            frameDataCache[this.jobID].latestFrameDecodeRequest = requestId;
            (frameDataCache[this.jobID].activeChunkRequest || Promise.resolve()).finally(() => {
                if (frameDataCache[this.jobID].latestFrameDecodeRequest !== requestId) {
                    // not relevant request anymore
                    reject(this.number);
                    return;
                }

                // it might appear during decoding, so, check again
                const currentFrame = provider.frame(this.number);
                if (currentFrame) {
                    resolve({
                        renderWidth: this.width,
                        renderHeight: this.height,
                        imageData: currentFrame,
                    });
                    return;
                }

                frameDataCache[this.jobID].activeChunkRequest = new Promise<void>((
                    resolveLoadAndDecode,
                ) => {
                    let wasResolved = false;
                    frameDataCache[this.jobID].getChunk(
                        chunkNumber, ChunkQuality.COMPRESSED,
                    ).then((chunk: ArrayBuffer) => {
                        try {
                            provider
                                .requestDecodeBlock(
                                    chunk,
                                    chunkNumber * chunkSize,
                                    Math.min(stopFrame, (chunkNumber + 1) * chunkSize - 1),
                                    (_frame: number, bitmap: ImageBitmap | Blob) => {
                                        if (decodeForward) {
                                            // resolve immediately only if is not playing
                                            return;
                                        }

                                        if (frameDataCache[this.jobID].latestFrameDecodeRequest === requestId &&
                                            this.number === _frame
                                        ) {
                                            wasResolved = true;
                                            resolve({
                                                renderWidth: this.width,
                                                renderHeight: this.height,
                                                imageData: bitmap,
                                            });
                                        }
                                    }, () => {
                                        frameDataCache[this.jobID].activeChunkRequest = null;
                                        resolveLoadAndDecode();
                                        const decodedFrame = provider.frame(this.number);
                                        if (decodeForward) {
                                            // resolve after decoding everything if playing
                                            resolve({
                                                renderWidth: this.width,
                                                renderHeight: this.height,
                                                imageData: decodedFrame,
                                            });
                                        } else if (!wasResolved) {
                                            reject(this.number);
                                        }
                                    }, (error: Error | RequestOutdatedError) => {
                                        frameDataCache[this.jobID].activeChunkRequest = null;
                                        resolveLoadAndDecode();
                                        if (error instanceof RequestOutdatedError) {
                                            reject(this.number);
                                        } else {
                                            reject(error);
                                        }
                                    },
                                );
                        } catch (error) {
                            reject(error);
                        }
                    }).catch((error) => {
                        reject(error);
                        resolveLoadAndDecode(error);
                    });
                });
            });
        });
    },
    writable: false,
});

function getFrameMeta(jobID, frame): RawFramesMetaData['frames'][0] {
    const { meta, mode, startFrame } = frameDataCache[jobID];
    let frameMeta = null;
    if (mode === 'interpolation' && meta.frames.length === 1) {
        // video tasks have 1 frame info, but image tasks will have many infos
        [frameMeta] = meta.frames;
    } else if (mode === 'annotation' || (mode === 'interpolation' && meta.frames.length > 1)) {
        if (frame > meta.stop_frame) {
            throw new ArgumentError(`Meta information about frame ${frame} can't be received from the server`);
        }
        frameMeta = meta.frames[frame - startFrame];
    } else {
        throw new DataError(`Invalid mode is specified ${mode}`);
    }

    return frameMeta;
}

export function getContextImage(jobID: number, frame: number): Promise<Record<string, ImageBitmap>> {
    return new Promise<Record<string, ImageBitmap>>((resolve, reject) => {
        if (!(jobID in frameDataCache)) {
            reject(new Error(
                'Frame data was not initialized for this job. Try first requesting any frame.',
            ));
        }
        const frameData = frameDataCache[jobID];
        const requestId = frame;
        const { startFrame } = frameData;
        const { related_files: relatedFiles } = frameData.meta.frames[frame - startFrame];

        if (relatedFiles === 0) {
            resolve({});
        } else if (frame in frameData.contextCache) {
            resolve(frameData.contextCache[frame].data);
        } else {
            frameData.latestContextImagesRequest = requestId;
            const executor = (): void => {
                if (frameData.latestContextImagesRequest !== requestId) {
                    reject(frame);
                } else if (frame in frameData.contextCache) {
                    resolve(frameData.contextCache[frame].data);
                } else {
                    frameData.activeContextRequest = serverProxy.frames.getImageContext(jobID, frame)
                        .then((encodedImages) => decodeContextImages(encodedImages, 0, relatedFiles));
                    frameData.activeContextRequest.then((images) => {
                        const size = Object.values(images)
                            .reduce((acc, image) => acc + image.width * image.height * 4, 0);
                        const totalSize = Object.values(frameData.contextCache)
                            .reduce((acc, item) => acc + item.size, 0);
                        if (totalSize > 512 * 1024 * 1024) {
                            const [leastTimestampFrame] = Object.entries(frameData.contextCache)
                                .sort(([, item1], [, item2]) => item1.timestamp - item2.timestamp)[0];
                            delete frameData.contextCache[leastTimestampFrame];
                        }

                        frameData.contextCache[frame] = {
                            data: images,
                            timestamp: Date.now(),
                            size,
                        };

                        if (frameData.latestContextImagesRequest !== requestId) {
                            reject(frame);
                        } else {
                            resolve(images);
                        }
                    }).finally(() => {
                        frameData.activeContextRequest = null;
                    });
                }
            };

            if (!frameData.activeContextRequest) {
                executor();
            } else {
                const checkAndExecute = (): void => {
                    if (frameData.activeContextRequest) {
                        // if we just execute in finally
                        // it might raise multiple server requests for context images
                        // if the promise was pending before and several requests came for the same frame
                        // all these requests will stuck on "finally"
                        // and when the promise fullfilled, it will run all the microtasks
                        // since they all have the same request id, all they will perform in executor()
                        frameData.activeContextRequest.finally(() => setTimeout(checkAndExecute));
                    } else {
                        executor();
                    }
                };

                setTimeout(checkAndExecute);
            }
        }
    });
}

export function decodePreview(preview: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result as string);
        };
        reader.onerror = (error) => {
            reject(error);
        };
        reader.readAsDataURL(preview);
    });
}

export async function getFrame(
    jobID: number,
    chunkSize: number,
    chunkType: 'video' | 'imageset',
    mode: 'interpolation' | 'annotation', // todo: obsolete, need to remove
    frame: number,
    startFrame: number,
    stopFrame: number,
    isPlaying: boolean,
    step: number,
    dimension: DimensionType,
    getChunk: (chunkNumber: number, quality: ChunkQuality) => Promise<ArrayBuffer>,
): Promise<FrameData> {
    if (!(jobID in frameDataCache)) {
        const blockType = chunkType === 'video' ? BlockType.MP4VIDEO : BlockType.ARCHIVE;
        const meta = await serverProxy.frames.getMeta('job', jobID);
        const updatedMeta = {
            ...meta,
            deleted_frames: Object.fromEntries(meta.deleted_frames.map((_frame) => [_frame, true])),
        };
        const mean = updatedMeta.frames.reduce((a, b) => a + b.width * b.height, 0) / updatedMeta.frames.length;
        const stdDev = Math.sqrt(
            updatedMeta.frames.map((x) => (x.width * x.height - mean) ** 2).reduce((a, b) => a + b) /
            updatedMeta.frames.length,
        );

        // limit of decoded frames cache by 2GB
        const decodedBlocksCacheSize = Math.min(
            Math.floor((2048 * 1024 * 1024) / ((mean + stdDev) * 4 * chunkSize)) || 1, 10,
        );
        frameDataCache[jobID] = {
            meta: updatedMeta,
            chunkSize,
            mode,
            startFrame,
            stopFrame,
            decodeForward: isPlaying,
            forwardStep: step,
            provider: new FrameDecoder(
                blockType,
                chunkSize,
                decodedBlocksCacheSize,
                dimension,
            ),
            decodedBlocksCacheSize,
            activeChunkRequest: null,
            activeContextRequest: null,
            latestFrameDecodeRequest: null,
            latestContextImagesRequest: null,
            contextCache: {},
            getChunk,
        };
    }

    const frameMeta = getFrameMeta(jobID, frame);
    frameDataCache[jobID].provider.setRenderSize(frameMeta.width, frameMeta.height);
    frameDataCache[jobID].decodeForward = isPlaying;
    frameDataCache[jobID].forwardStep = step;

    return new FrameData({
        width: frameMeta.width,
        height: frameMeta.height,
        name: frameMeta.name,
        related_files: frameMeta.related_files,
        frameNumber: frame,
        deleted: frame in frameDataCache[jobID].meta.deleted_frames,
        jobID,
    });
}

export async function getDeletedFrames(instanceType: 'job' | 'task', id) {
    if (instanceType === 'job') {
        const { meta } = frameDataCache[id];
        return meta.deleted_frames;
    }

    if (instanceType === 'task') {
        const meta = await serverProxy.frames.getMeta('task', id);
        meta.deleted_frames = Object.fromEntries(meta.deleted_frames.map((_frame) => [_frame, true]));
        return meta;
    }

    throw new Exception(`getDeletedFrames is not implemented for ${instanceType}`);
}

export function deleteFrame(jobID: number, frame: number): void {
    const { meta } = frameDataCache[jobID];
    meta.deleted_frames[frame] = true;
}

export function restoreFrame(jobID: number, frame: number): void {
    const { meta } = frameDataCache[jobID];
    if (frame in meta.deleted_frames) {
        delete meta.deleted_frames[frame];
    }
}

export async function patchMeta(jobID: number): Promise<void> {
    const { meta } = frameDataCache[jobID];
    const newMeta = await serverProxy.frames.saveMeta('job', jobID, {
        deleted_frames: Object.keys(meta.deleted_frames),
    });
    const prevDeletedFrames = meta.deleted_frames;

    // it is important do not overwrite the object, it is why we working on keys in two loops below
    for (const frame of Object.keys(prevDeletedFrames)) {
        delete prevDeletedFrames[frame];
    }
    for (const frame of newMeta.deleted_frames) {
        prevDeletedFrames[frame] = true;
    }

    frameDataCache[jobID].meta = newMeta;
    frameDataCache[jobID].meta.deleted_frames = prevDeletedFrames;
}

export async function findFrame(
    jobID: number, frameFrom: number, frameTo: number, filters: { offset?: number, notDeleted: boolean },
): Promise<number | null> {
    const offset = filters.offset || 1;
    let meta;
    if (!frameDataCache[jobID]) {
        meta = await serverProxy.frames.getMeta('job', jobID);
    } else {
        meta = frameDataCache[jobID].meta;
    }

    const sign = Math.sign(frameTo - frameFrom);
    const predicate = sign > 0 ? (frame) => frame <= frameTo : (frame) => frame >= frameTo;
    const update = sign > 0 ? (frame) => frame + 1 : (frame) => frame - 1;
    let framesCounter = 0;
    let lastUndeletedFrame = null;
    const check = (frame): boolean => {
        if (meta.included_frames) {
            return (meta.included_frames.includes(frame)) &&
            (!filters.notDeleted || !(frame in meta.deleted_frames));
        }
        if (filters.notDeleted) {
            return !(frame in meta.deleted_frames);
        }
        return true;
    };
    for (let frame = frameFrom; predicate(frame); frame = update(frame)) {
        if (check(frame)) {
            lastUndeletedFrame = frame;
            framesCounter++;
            if (framesCounter === offset) {
                return lastUndeletedFrame;
            }
        }
    }

    return lastUndeletedFrame;
}

export function getCachedChunks(jobID): number[] {
    if (!(jobID in frameDataCache)) {
        return [];
    }

    return frameDataCache[jobID].provider.cachedChunks(true);
}

export function clear(jobID: number): void {
    if (jobID in frameDataCache) {
        delete frameDataCache[jobID];
    }
}
