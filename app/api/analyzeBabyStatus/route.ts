import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DetectFacesCommand, RekognitionClient } from "@aws-sdk/client-rekognition";
import { NextResponse } from 'next/server';

// 添加调试日志
console.log('Environment variables check:', {
  accessKeyId: process.env.NEXT_PUBLIC_AWS_ACCESS_KEY_ID?.slice(0, 5), // 只打印前几位，避免泄露
  secretKeyExists: !!process.env.NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY,
  region: process.env.NEXT_PUBLIC_AWS_REGION
});

const accessKeyId = process.env.NEXT_PUBLIC_AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY;
const region = process.env.NEXT_PUBLIC_AWS_REGION || 'ap-southeast-1';

// 添加更严格的验证
if (!accessKeyId || !secretAccessKey) {
  throw new Error('AWS Credentials are missing or invalid');
}

if (accessKeyId.trim() === '' || secretAccessKey.trim() === '') {
  throw new Error('AWS Credentials cannot be empty strings');
}

const awsConfig = {
  region,
  credentials: {
    accessKeyId,
    secretAccessKey
  }
};

const bedrockClient = new BedrockRuntimeClient(awsConfig);
const rekognitionClient = new RekognitionClient(awsConfig);

// const bedrockClient = new BedrockRuntimeClient({ region: 'ap-southeast-1' });
// const rekognitionClient = new RekognitionClient({ region: 'ap-southeast-1' });


export async function POST(request: Request) {
  try {
    const { imageKey, imageBuffer, audioKey, audioFeatures } = await request.json();

    // 1. Analyze with Rekognition
    const rekognitionResponse = await rekognitionClient.send(new DetectFacesCommand({
      Image: {
        Bytes: Buffer.from(imageBuffer, 'base64')
      },
      Attributes: ['ALL']
    }));

    // Extract emotions and other facial attributes
    let faceAnalysis = {
      emotions: [] as string[],
      confidence: 0,
      eyesOpen: false,
      mouthOpen: false,
      isSmiling: false,
    };

    console.log("Rekognition Response:")
    console.log(rekognitionResponse);
    console.log(JSON.stringify(rekognitionResponse));

    if (rekognitionResponse.FaceDetails && rekognitionResponse.FaceDetails.length > 0) {
      const face = rekognitionResponse.FaceDetails[0];
      if (face.Emotions) {
        faceAnalysis.emotions = face.Emotions
          .sort((a, b) => (b.Confidence || 0) - (a.Confidence || 0))
          .slice(0, 2)
          .map(e => e.Type || '');
        faceAnalysis.confidence = face.Emotions[0].Confidence || 0;
      }
      faceAnalysis.eyesOpen = face.EyesOpen?.Value || false;
      faceAnalysis.mouthOpen = face.MouthOpen?.Value || false;
      faceAnalysis.isSmiling = face.Smile?.Value || false;
    } else {
        return NextResponse.json({
          imageKey,
          analysis: "No face was detected in the image",
          faceAnalysis: {
            emotions: [],
            confidence: 0,
            eyesOpen: false,
            mouthOpen: false,
            isSmiling: false,
          },
          needsAttention: false
        });
    }

    console.log("Face Analysis:")
    console.log(faceAnalysis);

    // 2. Analyze audio features
    let audioAnalysis = {
      hasCrying: false,
      hasLaughter: false,
      intensity: 0,
      duration: 0
    };

    if (audioFeatures) {
      const { rmsVolume, spectralFeatures, energyPattern, isCrying } = audioFeatures;
      
      // 综合判断哭声
      const hasCrying = isCrying || (
        // 备用判断逻辑
        spectralFeatures.fundamentalRatio > 0.2 &&
        spectralFeatures.harmonicRatio > 0.15 &&
        energyPattern.sustainedEnergy > 0.3
      );
      
      // 分析笑声特征
      const hasLaughter = (
        spectralFeatures.cryBands.highFreq > spectralFeatures.cryBands.fundamental &&
        energyPattern.transientCount > 5 &&
        energyPattern.sustainedEnergy < 0.3 &&
        rmsVolume > 0.05
      );
      
      // 计算整体声音强度，考虑持续性
      const intensity = Math.min(1, rmsVolume * 2 * (1 + energyPattern.sustainedEnergy));
      
      audioAnalysis = {
        hasCrying,
        hasLaughter,
        intensity,
        duration: audioFeatures.duration || 5
      };
    }

    // 3. Use Bedrock Claude for combined analysis
    const prompt = `
    分析婴儿的状态，基于以下信息：

    视觉分析：
    - 检测到的情绪: ${faceAnalysis.emotions.join(', ')}
    - 眼睛是否睁开: ${faceAnalysis.eyesOpen}
    - 嘴巴是否张开: ${faceAnalysis.mouthOpen}
    - 是否在微笑: ${faceAnalysis.isSmiling}

    声音分析：
    - 是否检测到哭声: ${audioAnalysis.hasCrying}
    - 是否检测到笑声: ${audioAnalysis.hasLaughter}
    - 声音强度: ${audioAnalysis.intensity}
    - 声音特征:
      * 低频能量 (250-600Hz): ${audioFeatures?.spectralFeatures.lowBandEnergy || 'N/A'}
      * 高频能量 (1000-2000Hz): ${audioFeatures?.spectralFeatures.highBandEnergy || 'N/A'}
      * 频率能量比: ${audioFeatures?.spectralFeatures.energyRatio || 'N/A'}
      * 能量突变次数: ${audioFeatures?.transientCount || 'N/A'}
    
    请综合分析视觉和声音信息，判断婴儿是否处于以下状态：
    1. 睡眠中 - 如果眼睛闭合且声音强度很低
    2. 哭泣中 - 如果检测到哭声特征或面部表情痛苦
    3. 开心/满足 - 如果在微笑或检测到笑声
    4. 不舒服 - 如果面部表情痛苦但没有明显哭声
    5. 饥饿 - 如果有轻微啼哭且嘴部活动频繁
    6. 平静 - 如果面部平和且无明显声音

    请按以下格式返回：

    <STATUS>睡眠中|哭泣中|开心|不舒服|饥饿|平静</STATUS>
    <ANALYSIS>
    在这里详细解释为什么根据检测到的面部特征、情绪和声音选择这个状态。
    请特别说明：
    1. 面部表情显示了什么情绪
    2. 声音特征表明了什么状态
    3. 综合判断的依据
    </ANALYSIS>
    `;
    
    const claudeResponse = await bedrockClient.send(new InvokeModelCommand({
      modelId: 'anthropic.claude-v2',
      body: JSON.stringify({
        prompt: `\n\nHuman: ${prompt}\n\nAssistant:`,
        max_tokens_to_sample: 500,
        temperature: 0.5,
      }),
      contentType: 'application/json',
    }));

    const analysis = JSON.parse(new TextDecoder().decode(claudeResponse.body)).completion;

    return NextResponse.json({
      imageKey,
      audioKey,
      analysis,
      faceAnalysis,
      audioAnalysis,
      needsAttention: analysis.includes('<STATUS>哭泣中</STATUS>') || 
                     analysis.includes('<STATUS>不舒服</STATUS>') ||
                     analysis.includes('<STATUS>饥饿</STATUS>') ||
                     (audioAnalysis.hasCrying && audioAnalysis.intensity > 0.6) ||
                     (faceAnalysis.emotions.includes('SAD') && audioAnalysis.intensity > 0.4) ||
                     (faceAnalysis.emotions.includes('ANGRY') && audioAnalysis.intensity > 0.3)
    });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}
