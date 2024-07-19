

export const msToHMS = (ms: number) => {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / 1000 / 60) % 60);
    const hours = Math.floor((ms / 1000 / 3600) % 24)
    
    const mss = ms - ((hours * 60 * 60 * 1000) + (minutes * 60 * 1000) + (seconds * 1000));

    const formatted = [
        pad(hours.toString(), 2),
        pad(minutes.toString(), 2),
        pad(seconds.toString(), 2),
    ].join(':');
    return [formatted, pad(mss.toString(), 3)].join('.');
}

const pad = (numberString: string, size: number) => {
    let padded = numberString;
    while (padded.length < size) {
        padded = `0${ padded }`;
    }
    return padded;
}
