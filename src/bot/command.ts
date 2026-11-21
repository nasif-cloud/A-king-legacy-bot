import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import {
  findKingLegacyItem,
  formatValueResponse,
  searchKingLegacyItems,
} from './values.js';

export const valueCommandData = new SlashCommandBuilder()
  .setName('value')
  .setDescription('check the value of an item')
  .addStringOption((option) =>
    option
      .setName('item')
      .setDescription('item name')
      .setRequired(true)
      .setAutocomplete(true),
  );

export async function handleValueAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focusedValue = String(interaction.options.getFocused() ?? '');
  const matches = searchKingLegacyItems(focusedValue, 25);

  await interaction.respond(
    matches.map((item) => ({
      name: item.name.slice(0, 100),
      value: item.name.slice(0, 100),
    })),
  );
}

export async function handleValueCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const query =
    interaction.options.getString('item') ??
    interaction.options.getString('items') ??
    interaction.options.getString('value') ??
    '';
  const item = findKingLegacyItem(query);

  if (!item) {
    await interaction.reply({
      content: `Could not find **"${query}"** in the King Legacy value list, try starting to type an item name to pick from autocomplete`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: formatValueResponse(item),
  });
}
