//Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//SPDX-License-Identifier: Apache-2.0

import { 
    TranscribeStreamingClient,
    TranscribeStreamingClientConfig,
    TranscriptResultStream,
    StartStreamTranscriptionCommand,
    TranscriptEvent,
} from '@aws-sdk/client-transcribe-streaming';
import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import chain from 'stream-chain';
import * as fs from 'fs';
import { WriteStream, createWriteStream } from 'fs';
import { PassThrough } from 'stream';
import BlockStream from 'block-stream2';
import { msToHMS } from '../utils/common';

const BYTES_PER_SAMPLE = 2;
const NUMBER_OF_CHANNELS = 2;
const CHUNK_SIZE_IN_MS = 100;
const SAMPLING_RATE = 8000;
const LANGUAGE_CODE = 'en-US';
const MEDIA_ENCODING = 'pcm';
const savePartial = false;
const FILTER_SILENCE='silenceremove=start_periods=1:start_duration=0:stop_periods=-1:stop_duration=1:start_threshold=-50dB:stop_threshold=-50dB'

export class Transcriber {
    readonly _client: TranscribeStreamingClient;
    readonly _mediafilename: string;
    readonly _outputfilename: string;
    readonly _transcriptoutput: string;
    fileWriter: WriteStream | null;


    constructor(mediaFileName: string, region?: string) {
        const clientconfig: TranscribeStreamingClientConfig = {
            region: region
        };
        try {
            this._client = new TranscribeStreamingClient(clientconfig);
            console.info('Created Transcribe Streaming client');
        } catch (error) {
            console.error('Error creating Transcribe Streaming client', error);
            process.exit(1);
        }

        this._mediafilename = mediaFileName;
        this._transcriptoutput = 'transcripts/'+mediaFileName.substring(mediaFileName.lastIndexOf('/')+1) + '.txt';
        this.fileWriter = createWriteStream(this._transcriptoutput, { encoding: 'utf-8' });

        this._outputfilename = 'data/' + mediaFileName.substring(mediaFileName.lastIndexOf('/') + 1) + 'silence_removed.wav';

    }

    async startTranscription(): Promise<void> {

        const CHUNK_SIZE = (SAMPLING_RATE * BYTES_PER_SAMPLE * NUMBER_OF_CHANNELS) * (CHUNK_SIZE_IN_MS / 1000);

        const inputStream = fs.createReadStream(this._mediafilename);
        const outputStreamBlock = new BlockStream({ size: CHUNK_SIZE });

        const writeStream = fs.createWriteStream('data/output_silence_removed.wav');

        const command = ffmpeg()
            .input(inputStream)
            .inputOptions([
                "-f s16le",
                "-ac 2",
                "-ar 8000"
            ])
            .audioFilter(FILTER_SILENCE)
            .outputOptions([
                "-f s16le",
                "-ac 2",
                "-ar 8000"
            ])
            .output(outputStreamBlock)
        
        outputStreamBlock.on('data', (chunk) => {
            writeStream.write(chunk);
        });

        await Promise.all([
            this.startFfmpeg(command),
            this.startTranscribe(outputStreamBlock),
        ]);

        writeStream.end();

    }

    private startFfmpeg(command: FfmpegCommand): Promise<void> {
        return new Promise((resolve, reject) => {
            command
                .on('start', (cmdLine) => {
                    console.log('starting ffmpeg with: ' + cmdLine);
                })
                .on('codecData', (data) => {
                    console.log('input file codec data', { data });
                })
                // .on('progress', (progress) => {
                //     console.log('ffmpeg progress report', { progress });
                // })
                .on('end', (stdout, stderr) => {
                    console.log('ffmpeg processing completed', { stdout, stderr });
                    resolve();
                })
                .on('error', (error, stdout, stderr) => {
                    console.log('error while running ffmpeg', { error, stdout, stderr });
                    reject(error);
                })
                .run();
        });
    }

    private async startTranscribe(source: PassThrough):Promise<void>{

        const timer = (millisec: number) => new Promise(cb => setTimeout(cb, millisec));

        const audiopipeline:chain = new chain([
            source,
            async (data) => {
                await timer(CHUNK_SIZE_IN_MS);
                return data;
            }
        ]);
            
        const transcribeInput = async function* () {
            for await (const chunk of audiopipeline) {
                yield { AudioEvent: { AudioChunk: chunk } };
            }
        };

        const response = await this._client.send(
            new StartStreamTranscriptionCommand({
                LanguageCode: LANGUAGE_CODE,
                MediaSampleRateHertz: SAMPLING_RATE,
                MediaEncoding: MEDIA_ENCODING,
                EnableChannelIdentification: true,
                NumberOfChannels: NUMBER_OF_CHANNELS,
                ShowSpeakerLabel: false,
                VocabularyName: undefined,
                AudioStream: transcribeInput()
            })
        );
        console.info(
            `${this._mediafilename}, ${response.SessionId}, STARTED`
        ); 
        const outputTranscriptStream: AsyncIterable<TranscriptResultStream> | undefined = response.TranscriptResultStream;
    
        if (outputTranscriptStream) {   
            for await (const event of outputTranscriptStream) {
                if (event.TranscriptEvent) {
                    const message: TranscriptEvent = event.TranscriptEvent;
                    await this.writeTranscriptionSegment(message);
                }
            }
            this.fileWriter?.close();
            console.info(
                `${this._mediafilename}, ${response.SessionId}, COMPLETED`
            );
        }
    }

    private async writeTranscriptionSegment(transcribeMessageJson:TranscriptEvent):Promise<void> {

        if (transcribeMessageJson.Transcript?.Results && transcribeMessageJson.Transcript?.Results.length > 0) {
            if (transcribeMessageJson.Transcript?.Results[0].Alternatives && transcribeMessageJson.Transcript?.Results[0].Alternatives?.length > 0) {
               
                const result = transcribeMessageJson.Transcript?.Results[0];
    
                if (result.IsPartial == undefined || (result.IsPartial == true && !savePartial)) {
                    return;
                }
                const { Transcript: transcript } = transcribeMessageJson.Transcript.Results[0].Alternatives[0];
                const items = transcribeMessageJson.Transcript.Results[0].Alternatives[0].Items;
                let starttime: string = '-1';
                let endtime: string = '-1';
                if (items && items.length > 0) {
                    starttime = msToHMS(items[0].StartTime! * 1000);
                    endtime = msToHMS(items[items.length - 1].EndTime! * 1000);
                }
                const fmtedTranscript = `${starttime} ${endtime} - ${transcript} \n`;
                this.fileWriter?.write(fmtedTranscript);
                console.log(fmtedTranscript)
                // this.fileWriter?.write(JSON.stringify(transcribeMessageJson.Transcript.Results[0].Alternatives[0])+'\n');
            }
        }
    }


}