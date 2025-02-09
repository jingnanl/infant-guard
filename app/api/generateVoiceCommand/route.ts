import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

const pollyClient = new PollyClient({ region: 'ap-southeast-1' });

export async function GET() {
  try {
    const pollyResponse = await pollyClient.send(new SynthesizeSpeechCommand({
      Text: '天猫精灵，播放摇篮曲',
      OutputFormat: 'mp3',
      VoiceId: 'Zhiyu'
    }));

    if (!pollyResponse.AudioStream) {
      return new Response('Failed to generate audio', { status: 500 });
    }

    const audioBuffer = await pollyResponse.AudioStream.transformToByteArray();
    
    return new Response(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString()
      }
    });
  } catch (error) {
    console.error('Error generating voice command:', error);
    return new Response('Error generating voice command', { status: 500 });
  }
} 