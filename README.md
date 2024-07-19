Transcribe streaming client utility makes it easier to test Transcribe streaming API by streaming an audio file to Transcribe service. This code sample uses WAV file input that is 

1. PCM Signed 16 bit Little Endian format
2. 8000 Hz sampling rate
3. Stereo (two channels)

The audio stream is filtered to remove silence before sending the stream to Transcribe streaming to create real-time transcriptions. 

## How to use
The code runs locally from your terminal command line or from cloud shell/cloud9 command line. 
git clone the repo to your local environment where you have setup AWS credentails. 

From root directory of the local repo, 
1. `npm run setup` to setup the package dependencies

2. `npm run buildcheck` to check for build error

3. `npm run exec <mediaFileName> [region]` where 

    `<mediaFileName>` - call recording (wav file) - PCM-S16, 8000Hz, Stereo

    `[region]` - AWS region. Defaults to 'us-east-1'

    e.g. `npm run exec data/sample_pcm16s_stereo_with_silence.wav us-east-1`

4. Transcripts are written to `transcripts/` directory and the console
5. For troubleshooting, the updated (silence removed) output stream is 
written to a wav file (`output_silence_removed.wav`) in `data/` directory.

Notes:

1. Sample audio file with silence are provided in `data/` directory.