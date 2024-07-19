//Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//SPDX-License-Identifier: Apache-2.0

import { Command  } from 'commander';
import * as fs from 'fs';

import { Transcriber } from './transcriber';
  
new Command()
    .description('Transcribe Streaming API Client Sample')
    
    .showHelpAfterError()
    
    .argument('<media-filename>', 'Required: Call recording file name - stereo only')
    .argument('[region]', 'Optional: AWS Region. Default to AWS_REGION or us-east-1')

    .action(async (mediaFileName: string, region: string): Promise<void> => {
       
        try {
            fs.accessSync(mediaFileName, fs.constants.R_OK);
        } catch (err) {
            console.error('File does not exist or you do not have read permissions');
            console.error(err);
            process.exit(1);
        }
        if (!region) {
            region = 'us-east-1';
            console.info('Region parameter was not provided. Defaulted to us-east-1');
        }

        const transcriber = new Transcriber(mediaFileName, region);
        (async () => {
            await transcriber.startTranscription();
        })();

    })
    .parse(process.argv);