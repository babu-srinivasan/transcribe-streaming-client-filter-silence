import { open, FileHandle } from 'fs/promises';

export type AudioFormat = 'PCMU' | 'L16';
export type SampleRate = 8000 | 16000 | 44100 | 48000;
export const defaultSupportedRates: readonly SampleRate[] = [8000, 16000, 44100, 48000] as const;

export const createWavHeader = function createHeader(length: number, samplingRate: number) {
    const buffer = Buffer.alloc(44);

    // RIFF identifier 'RIFF'
    buffer.writeUInt32BE(1380533830, 0);
    // file length minus RIFF identifier length and file description length
    buffer.writeUInt32LE(36 + length, 4);
    // RIFF type 'WAVE'
    buffer.writeUInt32BE(1463899717, 8);
    // format chunk identifier 'fmt '
    buffer.writeUInt32BE(1718449184, 12);
    // format chunk length
    buffer.writeUInt32LE(16, 16);
    // sample format (raw)
    buffer.writeUInt16LE(1, 20);
    // channel count
    buffer.writeUInt16LE(2, 22);
    // sample rate
    buffer.writeUInt32LE(samplingRate, 24);
    // byte rate (sample rate * block align)
    buffer.writeUInt32LE(samplingRate * 2 * 2, 28);
    // block align (channel count * bytes per sample)
    buffer.writeUInt16LE(2 * 2, 32);
    // bits per sample
    buffer.writeUInt16LE(16, 34);
    // data chunk identifier 'data'
    buffer.writeUInt32BE(1684108385, 36);
    buffer.writeUInt32LE(length, 40);

    return buffer;
};

export interface WavReader {
    readonly format: AudioFormat;
    readonly rate: SampleRate;
    readonly channels: number;
    close(): Promise<void>;
    readNext(samples: number): Promise<Uint8Array | Int16Array | null>;
}

class WavFileReader implements WavReader {
    private file: FileHandle;
    private dataStartPos: number;
    private readPos: number;
    private dataChunkSize: number;
    private bytesPerSample: number;
    private maxFrameSamples: number;
    private bufferFactory: (bytes: number) => Int16Array | Uint8Array;
    readonly format: AudioFormat;
    readonly rate: SampleRate;
    readonly channels: number;

    constructor(file: FileHandle, startPos: number, dataChunkSize: number, format: AudioFormat, rate: SampleRate, channels: number) {
        this.file = file;
        this.format = format;
        this.rate = rate;
        this.channels = channels;
        this.dataStartPos = startPos;
        this.readPos = 0;
        this.dataChunkSize = dataChunkSize;
        this.maxFrameSamples = 10 * this.rate; // Read at most 10s at a time
        if (format === 'L16') {
            this.bytesPerSample = 2 * channels;
            this.bufferFactory = (bytes) => new Int16Array(bytes / 2);
        } else {
            this.bytesPerSample = channels;
            this.bufferFactory = (bytes) => new Uint8Array(bytes);
        }
    }

    async close(): Promise<void> {
        this.readPos = this.dataChunkSize;
        await this.file.close();
    }

    async readNext(samples: number): Promise<Uint8Array | Int16Array | null> {
        const ask = (
            (samples <= 0) ? (
                this.rate
            ) : (samples > this.maxFrameSamples) ? (
                this.maxFrameSamples
            ) : (
                samples
            )
        ) * this.bytesPerSample;
        const pos = this.readPos;
        const available = Math.min(this.dataChunkSize - pos, ask);
        if (available === 0) {
            return null;
        }
        this.readPos += available;
        const buf = this.bufferFactory(available);
        const res = await this.file.read({
            buffer: buf,
            position: this.dataStartPos + pos,
        });
        if (res.bytesRead !== available) {
            throw new Error('Corrupt file: Truncated data chunk.');
        }
        return buf;
    }
}

export type WavFileReaderOptions = {
    allowedRates?: readonly SampleRate[];
    channelMin?: number;
    channelMax?: number;
};

export const createWavFileReader = async (filename: string, options: WavFileReaderOptions): Promise<WavReader> => {
    let file: FileHandle | null = null;
    try {
        file = await open(filename, 'r');
        const headerSize = 44;
        const headerData = await file.read({
            buffer: Buffer.alloc(headerSize),
            offset: 0,
            length: headerSize,
            position: 0,
        });
        if (headerData.bytesRead !== headerSize) {
            throw new Error('File too small for valid WAV file');
        }
        const headerView = new DataView(headerData.buffer.buffer);
        if (headerView.getUint32(0, false) !== 0x52494646) {    // 'RIFF'
            throw new Error('Not a valid/supported WAV file (RIFF tag missing)');
        }
        if (headerView.getUint32(8, false) !== 0x57415645) {    // 'WAVE'
            throw new Error('Not a valid/supported WAV file (no WAVE chunk');
        }
        if (headerView.getUint32(12, false) !== 0x666d7420) {   // 'fmt '
            throw new Error('Not a valid/supported WAV file (no fmt chunk)');
        }
        const fmtChunkSize = headerView.getUint32(16, true);
        if ((fmtChunkSize !== 16) && (fmtChunkSize !== 18) && (fmtChunkSize !== 40)) {
            throw new Error('Not a valid/supported WAV file (bad fmt chunk size)');
        }

        const formatTag = headerView.getUint16(20, true);
        let format: AudioFormat;
        if (formatTag === 1) {
            format = 'L16';
        } else if (formatTag === 7) {
            format = 'PCMU';
        } else {
            throw new Error(`Unsupported WAV format tag (${formatTag}). Only supporting 1(L16) and 7(PCMU)`);
        }

        const channels = headerView.getUint16(22, true);
        if ((channels < (options.channelMin ?? 1)) || (channels > (options.channelMax ?? 16))) {
            throw new Error(`Invalid number of channels: ${channels}`);
        }
        const rate = headerView.getUint32(24, true);
        const allowedRates: readonly number[] = (options.allowedRates ?? defaultSupportedRates);
        if (!allowedRates.includes(rate)) {
            throw new Error(`Unsupported sample rate (${rate}). Supported: ${allowedRates.join(',')}`);
        }
        const bytesPerSample = headerView.getUint16(32, true);
        if (bytesPerSample !== (channels * ((formatTag === 1) ? 2 : 1))) {
            throw new Error(`Invalid bytesPerSample for ${channels} channel ${format}`);
        }

        // Now search for 'data' chunk
        // Start after 'fmt ' chunk
        let pos = 20 + fmtChunkSize;
        const chunk = Buffer.alloc(8);
        for(;;) {
            const res = await file.read({
                buffer: chunk,
                offset: 0,
                length: chunk.byteLength,
                position: pos,
            });
            if(res.bytesRead !== chunk.byteLength) {
                throw new Error('Corrupt or invalid WAV file (no data chunk found)');
            }
            const view = new DataView(chunk.buffer);
            let dataSize = view.getUint32(4, true);
            if (view.getUint32(0, false) === 0x64617461) {      // 'data' chunk
                if(dataSize === 0xffffffff) {
                    // Data chunk spans to end of file
                    const stats = await file.stat();
                    dataSize = stats.size - 8 - pos;
                }
                const reader = new WavFileReader(file, pos + 8, dataSize, format, rate as SampleRate, channels);
                file = null;    // File is now owned by reader
                return reader;
            }
            pos += 8 + dataSize + (dataSize % 2);
        }
    } finally {
        await file?.close();
    }
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lookup table to convert u-Law bytes to their Linear-16 sample values
 */
const ulawToL16Lut = new Int16Array([
    -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
    -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
    -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
    -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
    -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
    -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
    -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
    -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
    -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
    -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
    -876, -844, -812, -780, -748, -716, -684, -652,
    -620, -588, -556, -524, -492, -460, -428, -396,
    -372, -356, -340, -324, -308, -292, -276, -260,
    -244, -228, -212, -196, -180, -164, -148, -132,
    -120, -112, -104, -96, -88, -80, -72, -64,
    -56, -48, -40, -32, -24, -16, -8, -1,
    32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
    23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
    15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
    11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
    7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
    5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
    3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
    2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
    1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
    1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
    876, 844, 812, 780, 748, 716, 684, 652,
    620, 588, 556, 524, 492, 460, 428, 396,
    372, 356, 340, 324, 308, 292, 276, 260,
    244, 228, 212, 196, 180, 164, 148, 132,
    120, 112, 104, 96, 88, 80, 72, 64,
    56, 48, 40, 32, 24, 16, 8, 0
]);

/**
 * Lookup table to determine u-Law exponent from clamped absolute sample value.
 */
const ulawExpLut = new Uint8Array([
    0, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
]);

/**
 * Encodes a sample of Linear16 encoded audio samples in range [-32768, 32767] to u-Law
 *
 * Values outside range of signed 16-bit [-32768, 32767] are clamped/saturated.
 * 
 * @param sample Sample to encode, valid range [-32768, 32767]
 * @returns U-law encoded sample 
 */
export const ulawFromL16Sample = (sample: number): number => {
    let x: number;
    let ulaw: number;
    if (sample < 0) {
        x = ((sample <= -32635) ? 32635 : -sample) + 132;     // Negate sample, clamp, and add bias (4*33)
        ulaw = 0x7f;
    } else {
        x = ((sample >= 32635) ? 32635 : sample) + 132;     // Clamp sample and add bias (4*33)
        ulaw = 0xff;
    }
    const exp = ulawExpLut[x >> 8];
    return ulaw - ((exp << 4) | ((x >> (exp + 3)) & 0x0f));
};

/**
 * Decodes a u-law encoded sample to Linear16.
 * 
 * Input is expected to be in range 0...255 (8bit unsigned).
 * 
 * @param sample Byte value representing sample encoded in u-law
 * @returns Linear16 sample value [-32768, 32767]
 */
export const ulawToL16Sample = (sample: number): number => {
    return ulawToL16Lut[sample] ?? 0;
};


const encodeFromArray = (data: Int16Array | number[]): Uint8Array => {
    const size = data.length;
    const res = new Uint8Array(size);
    for (let i = 0; i < size; ++i) {
        res[i] = ulawFromL16Sample(data[i]);
    }
    return res;
};

const encodeFromDataView = (dataview: DataView): Uint8Array => {
    const size = dataview.byteLength / 2;
    const res = new Uint8Array(size);
    let s = 0;
    for (let i = 0; i < size; ++i, s += 2) {
        res[i] = ulawFromL16Sample(dataview.getInt16(s, true));
    }
    return res;
};

/**
 * Decodes an array of audio samples encoded with u-Law to Linear16
 * 
 * @param {Uint8Array} ulawBuf Array of u-Law bytes to convert to Linear16
 * @returns {Int16Array} Array of Linear16 samples [-32768, 32767]
 */
export const ulawToL16 = (ulawBuf: Uint8Array): Int16Array => {
    const size = ulawBuf.length;
    const res = new Int16Array(size);
    for (let i = 0; i < size; ++i) {
        res[i] = ulawToL16Lut[ulawBuf[i]];
    }
    return res;
};

/**
 * Encodes an array of Linear16 encoded audio samples in range [-32768, 32767] to u-Law
 * 
 * Values outside range of signed 16-bit [-32768, 32767] are clamped/saturated.
 * 
 * @param src Typed array of Linear16 audio samples in range [-32768, 32767]. If the argument is a Uint8Array or DataView, 
 *            it is assumed to contain the audio as little-endian 16-bit samples.
 *              
 * @returns Array of samples encoded in u-Law
 */
export const ulawFromL16 = (src: Int16Array | number[] | Uint8Array | DataView): Uint8Array => {
    if (src instanceof Int16Array) {
        return encodeFromArray(src);
    } else if (src instanceof DataView) {
        return encodeFromDataView(src);
    } else if (src instanceof Uint8Array) {
        return encodeFromDataView(new DataView(src.buffer, src.byteOffset, src.byteLength));
    } else {
        return encodeFromArray(src);
    }
};


export const msToBytes = (ms: number, samplerate: number, samplebytes: number): number => {
    return samplerate * (ms / 1000) * samplebytes;
};